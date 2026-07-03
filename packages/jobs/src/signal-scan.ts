import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import {
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
 * gleicher Strategie/Symbol/TF/Richtung/Setup, wird nicht dupliziert.
 * NUR echte Kerzen aus der DB — nichts wird erfunden.
 */

export const SCAN_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
export const SCAN_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
type Timeframe = (typeof SCAN_TIMEFRAMES)[number];

const HIGHER_TF: Record<Timeframe, Timeframe | null> = {
  '15m': '1h',
  '1h': '4h',
  '4h': '1d',
  '1d': null,
};

/** Mindest-Kerzen, damit EMA200 & Co. definiert sind. */
const MIN_CANDLES = 220;
const LOAD_LIMIT = 400;

function emaTrendOf(candles: Candle[], period: number): 'bull' | 'bear' | 'neutral' {
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
  scanned: { symbol: string; timeframe: string; candles: number }[];
  inserted: number;
  skippedDuplicates: number;
};

export async function runSignalScan(db: Db): Promise<ScanResult> {
  const { strategyId, versionId } = await ensureSmcCoreStrategy(db);
  const result: ScanResult = { scanned: [], inserted: 0, skippedDuplicates: 0 };

  for (const symbol of SCAN_SYMBOLS) {
    // Höhere TF-Trends einmal je Symbol laden
    const higherTrends = new Map<Timeframe, 'bull' | 'bear' | 'neutral'>();
    for (const tf of SCAN_TIMEFRAMES) {
      const higher = HIGHER_TF[tf];
      if (!higher || higherTrends.has(higher)) continue;
      const candles = await getOhlcv(db, { symbol, timeframe: higher, limit: LOAD_LIMIT });
      higherTrends.set(higher, emaTrendOf(candles, SMC_CORE_DEFAULTS.emaTrendPeriod));
    }

    for (const timeframe of SCAN_TIMEFRAMES) {
      const candles = await getOhlcv(db, { symbol, timeframe, limit: LOAD_LIMIT });
      result.scanned.push({ symbol, timeframe, candles: candles.length });
      if (candles.length < MIN_CANDLES) continue; // ehrlich: zu wenig Historie → kein Scan

      const higher = HIGHER_TF[timeframe];
      const candidates = evaluateSmcCoreAt(candles, candles.length - 1, SMC_CORE_DEFAULTS, {
        higherTfTrend: higher ? higherTrends.get(higher) : 'neutral',
      });

      for (const candidate of candidates) {
        const inserted = await persistCandidate(db, {
          candidate,
          symbol,
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
    timeframe: string;
    strategyId: string;
    versionId: string;
  },
): Promise<boolean> {
  const { candidate, symbol, timeframe, strategyId, versionId } = opts;

  // Dedupe: gleiches offenes Setup existiert bereits
  const dup = await db.execute(sql`
    SELECT 1 FROM signals
    WHERE strategy_id = ${strategyId} AND symbol = ${symbol} AND timeframe = ${timeframe}
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
    timeframe,
    assetClass: 'crypto',
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
    emaRegime: candidate.emaRegime,
    marketPhase: candidate.marketPhase,
    status: 'new',
  });
  return true;
}
