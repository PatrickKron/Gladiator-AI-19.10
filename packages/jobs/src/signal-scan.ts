import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type { AssetClass } from '@gladiator/core';
import { getOhlcv, isCandleFresh } from '@gladiator/market-data';
import { ensureCandles } from './universe.js';
import { registeredAssets } from './asset-register.js';
import { AGGREGATE_LOOKBACK_MS, buildScanTargets, prepareScanCandles, scanSourceTimeframe, type ScanTarget } from './scan-targets.js';
import { expireStaleSignals } from './signal-expiry.js';
import {
  deriveLifecyclePlans,
  evaluateSmcCoreAt,
  SMC_CORE_DEFAULTS,
  type Candle,
  type SetupCandidate,
} from '@gladiator/strategy-engine';

const { strategies, strategyVersions, signals } = schema;

/**
 * Multi-Timeframe-Signal-Scan (05_ §7/§11):
 * Für jedes Symbol × Timeframe wird der LETZTE ABGESCHLOSSENE Bar mit SMC Core
 * bewertet; der Trend der nächsthöheren Timeframe (EMA-Trend) geht als
 * Kontext ein (Top-Down-Pflicht). Kandidaten (Score ≥ 6) landen als
 * kanonische Signale in der DB. Dedupe: existiert bereits ein 'new'-Signal
 * gleicher Strategie/Quelle/Symbol/TF/Richtung/Setup, wird nicht dupliziert.
 * NUR echte Kerzen aus der DB — nichts wird erfunden.
 *
 * Je Quelle (A1, 2026-10-27): Universum = Asset-Register (Binance, Yahoo, Twelve Data;
 * scan-targets.ts). Nur abgeschlossene Kerzen; Börsen-Quellen bekommen 4h aus 1h; veraltete
 * Reihen (Börse lange zu, Quelle hängt) werden nicht bewertet. Kerzen von Yahoo/Twelve Data hält
 * der Kerzen-Refresh-Job frisch, Binance der Scan selbst.
 */

export const SCAN_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']; // Basis — Favoriten erweitern zur Laufzeit (universe.ts)
export const SCAN_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
type Timeframe = (typeof SCAN_TIMEFRAMES)[number];

export const HIGHER_TF: Record<Timeframe, Timeframe | null> = {
  '15m': '1h',
  '1h': '4h',
  '4h': '1d',
  '1d': null,
};

/** Mindest-Kerzen, damit EMA200 & Co. definiert sind. */
const MIN_CANDLES = 220;
const LOAD_LIMIT = 400;

export function emaTrendOf(candles: Candle[], period: number): 'bull' | 'bear' | 'neutral' {
  if (candles.length < period) return 'neutral';
  const k = 2 / (period + 1);
  let value = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) value = candles[i]!.close * k + value * (1 - k);
  const last = candles[candles.length - 1]!.close;
  if (last > value) return 'bull';
  if (last < value) return 'bear';
  return 'neutral';
}

/** Stellt sicher, dass die SMC-Core-Strategie + Version 1 registriert sind. */
export async function ensureSmcCoreStrategy(db: Db): Promise<{ strategyId: string; versionId: string }> {
  const [strategy] = await db
    .insert(strategies)
    .values({
      slug: 'smc-core',
      name: 'SMC Core (Pine-Referenz)',
      kind: 'builtin',
      description: 'BOS/CHoCH + EMA-Trend + Pflicht-Retest + RSI-Band + Volumen (05_ §4).',
    })
    .onConflictDoNothing({ target: strategies.slug })
    .returning();
  const strategyRow =
    strategy ?? (await db.select().from(strategies).where(eq(strategies.slug, 'smc-core')).limit(1))[0]!;

  const [version] = await db
    .insert(strategyVersions)
    .values({ strategyId: strategyRow.id, version: 1, params: SMC_CORE_DEFAULTS, status: 'paper' })
    .onConflictDoNothing()
    .returning();
  const versionRow =
    version ??
    (
      await db
        .select()
        .from(strategyVersions)
        .where(and(eq(strategyVersions.strategyId, strategyRow.id), eq(strategyVersions.version, 1)))
        .limit(1)
    )[0]!;

  return { strategyId: strategyRow.id, versionId: versionRow.id };
}

export type ScanResult = {
  scanned: { symbol: string; venue: string; timeframe: string; candles: number; stale?: boolean }[];
  inserted: number;
  skippedDuplicates: number;
  /** Überfällige 'new'-Signale, die dieser Lauf auf 'expired' gesetzt hat. */
  expired: number;
  /** Registrierte Assets ohne Signal-Klasse (mit Grund) — nie geraten. */
  skippedAssets: string[];
};

/** Scan-Ziele aus dem Asset-Register (Basis + Favoriten + Hinzugefügte, alle Quellen). */
export async function scanTargets(db: Db): Promise<{ targets: ScanTarget[]; skipped: string[] }> {
  return buildScanTargets(await registeredAssets(db));
}

/** Abgeschlossene Kerzen eines Ziels im Scan-Zeitrahmen (Börsen-Quellen: 4h aus 1h). */
async function loadScanCandles(db: Db, target: ScanTarget, timeframe: string, now: Date): Promise<Candle[]> {
  const sourceTf = scanSourceTimeframe(target.venue, timeframe);
  const raw = await getOhlcv(db, {
    venue: target.venue,
    symbol: target.symbol,
    timeframe: sourceTf,
    ...(sourceTf === timeframe ? { limit: LOAD_LIMIT + 1 } : { since: new Date(now.getTime() - AGGREGATE_LOOKBACK_MS), until: now }),
  });
  return prepareScanCandles(target.venue, timeframe, raw, now).slice(-LOAD_LIMIT);
}

export async function runSignalScan(db: Db, opts: { now?: Date } = {}): Promise<ScanResult> {
  const now = opts.now ?? new Date();
  const { strategyId, versionId } = await ensureSmcCoreStrategy(db);
  const result: ScanResult = { scanned: [], inserted: 0, skippedDuplicates: 0, expired: 0, skippedAssets: [] };

  // Zuerst veraltete offene Signale ablaufen lassen → „offen"-Liste bleibt aktuell.
  result.expired = await expireStaleSignals(db);
  if (result.expired > 0) console.log(`[signal-scan] ${result.expired} überfällige Signale auf 'expired' gesetzt.`);

  // Universum = Asset-Register (alle Quellen). Binance-Symbole inkrementell frisch
  // halten — auch die Basis: deren Kerzen kommen sonst nur aus dem Seed und veralten
  // für immer. Yahoo/Twelve Data hält der Kerzen-Refresh-Job (alle 15 min) frisch.
  const { targets, skipped } = await scanTargets(db);
  result.skippedAssets = skipped;
  for (const target of targets) {
    if (target.venue !== 'binance') continue;
    const fill = await ensureCandles(db, target.symbol);
    if (fill.inserted > 0) console.log(`[signal-scan] Backfill ${target.symbol}: +${fill.inserted} Kerzen`);
    for (const e of fill.errors) console.warn('[signal-scan] Backfill', e);
  }

  for (const target of targets) {
    const { symbol, venue } = target;
    // Jede Reihe einmal je Ziel laden (Scan-TF und Trend-Kontext der nächsthöheren TF).
    const series = new Map<Timeframe, Candle[]>();
    const candlesOf = async (tf: Timeframe) => {
      let c = series.get(tf);
      if (!c) {
        c = await loadScanCandles(db, target, tf, now);
        series.set(tf, c);
      }
      return c;
    };

    for (const timeframe of SCAN_TIMEFRAMES) {
      const candles = await candlesOf(timeframe);
      const last = candles[candles.length - 1];
      const stale = last !== undefined && !isCandleFresh(last.ts, timeframe, venue, now);
      result.scanned.push({ symbol, venue, timeframe, candles: candles.length, ...(stale ? { stale } : {}) });
      if (candles.length < MIN_CANDLES) continue; // ehrlich: zu wenig Historie → kein Scan
      if (stale) continue; // Börse lange zu / Quelle hängt → keine Signale auf alten Kerzen

      const higher = HIGHER_TF[timeframe];
      const higherTfTrend = higher ? emaTrendOf(await candlesOf(higher), SMC_CORE_DEFAULTS.emaTrendPeriod) : 'neutral';
      const candidates = evaluateSmcCoreAt(candles, candles.length - 1, SMC_CORE_DEFAULTS, { higherTfTrend });

      for (const candidate of candidates) {
        const inserted = await persistCandidate(db, {
          candidate,
          symbol,
          venue,
          assetClass: target.assetClass,
          timeframe,
          strategyId,
          versionId,
        });
        if (inserted) result.inserted++;
        else result.skippedDuplicates++;
      }
    }
  }

  return result;
}

async function persistCandidate(
  db: Db,
  opts: {
    candidate: SetupCandidate;
    symbol: string;
    venue: string;
    assetClass: AssetClass;
    timeframe: string;
    strategyId: string;
    versionId: string;
  },
): Promise<boolean> {
  const { candidate, symbol, venue, assetClass, timeframe, strategyId, versionId } = opts;

  // Dedupe: gleiches offenes Setup existiert bereits
  const dup = await db.execute(sql`
    SELECT 1 FROM signals
    WHERE strategy_id = ${strategyId} AND venue = ${venue} AND symbol = ${symbol} AND timeframe = ${timeframe}
      AND direction = ${candidate.direction} AND setup_type = ${candidate.setupType}
      AND status = 'new'
    LIMIT 1
  `);
  if (dup.rows.length > 0) return false;

  await db.insert(signals).values({
    source: 'engine',
    strategyId,
    strategyVersionId: versionId,
    symbol,
    venue,
    timeframe,
    assetClass,
    // Ausführungsort-Typ: Binance wie die Börsen-Quellen sind zentrale Märkte; die Kerzenquelle steht in `venue`.
    venueType: 'cex',
    direction: candidate.direction,
    setupType: candidate.setupType,
    entry: String(candidate.entry),
    stopLoss: String(candidate.stopLoss),
    takeProfits: candidate.takeProfits.map(String),
    leverageSuggested: '1',
    score: String(candidate.score),
    riskClass: candidate.riskClass,
    confluence: candidate.confluence,
    session: candidate.session,
    // 05_ §9: Reentry-Plan + Leverage-Upgrade-Bedingungen je Setup-Typ (Werte 05_ §5) —
    // der Signal-Lifecycle-Monitor wertet sie aus, ausgeführt wird nichts automatisch.
    ...deriveLifecyclePlans(candidate),
    emaRegime: candidate.emaRegime,
    marketPhase: candidate.marketPhase,
    status: 'new',
  });
  return true;
}
