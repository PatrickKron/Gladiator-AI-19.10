import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { assetProfile, type ProfileAssetClass } from '@gladiator/core';
import { getCotSnapshot, getDerivativesSnapshot, getMacroSnapshot, getOhlcv, upcomingEvents, type CotStatus } from '@gladiator/market-data';
import { intradayMovePct, SAFE_003_BTC_INTRADAY_MAX_PCT, SAFE_003_ETH_INTRADAY_MAX_PCT } from '@gladiator/risk';
import { loadIntradayMovePct, loadNoTradeWindow } from '@gladiator/exchange';
import { atr } from '@gladiator/strategy-engine';
import { ensureTradingSettings } from '../routers/settings.js';
import { buildAssetEventView, type AssetEventView } from './asset-events.js';

/**
 * Asset-Analyse auf einen Klick (Patricks Mängelliste 2026-10-22, Punkt 6): die drei Blicke
 * Oracle (Makro & Regime), Shadow (Positionierung: Funding, Open Interest, COT) und Sentinel
 * (Risiko-Wächter: No-Trade-Fenster, Kill-Switch, Limits, Exposure) für GENAU ein Asset —
 * alles aus echten, bereits synchronisierten Daten. Fehlt eine Quelle, steht ehrlich
 * `connected: false`; nichts wird geschätzt. Seite UND Gladiator-Chat nutzen diese Funktion.
 *
 * Je Asset (Patrick 2026-10-25): Kerzenquelle `venue` (Binance, Yahoo, Twelve Data), Termine nach
 * den Währungen des Assets gefiltert — die Engine-Sperre bleibt GLOBAL und steht immer da
 * (`noTrade.active` + `scope`), Exposure getrennt nach Agent und Demo.
 */
export type AssetAnalysis = {
  symbol: string;
  venue: string;
  asOf: string;
  profile: { assetClass: ProfileAssetClass; base: string | null; currencies: string[] | null; quoteCurrency: string | null } | null;
  macro: { connected: boolean; grs: { score: number; label: 'risk-on' | 'neutral' | 'risk-off' } | null; vix: number | null; dxy: number | null; us10y: number | null; asOf: string | null };
  cot: { applicable: boolean; connected: boolean; market: string | null; inverse: boolean; status: CotStatus | null; netRatio: number | null; percentile: number | null; weekChange: number | null; reportDate: string | null };
  /** `applicable: false` = es gibt für dieses Asset keinen Binance-Perp-Feed (Nicht-Krypto oder andere Quelle). */
  derivatives: { applicable: boolean; connected: boolean; fundingRate: number | null; openInterest: number | null; oiChangePct24h: number | null; asOf: string | null };
  /**
   * `active`/`reason` = Sperre der Engine (GLOBAL, exakt `loadNoTradeWindow`); `scope` sagt, ob ihr
   * Termin dieses Asset betrifft. `nextHigh`/`upcoming` = High-Impact-Termine DIESES Assets.
   */
  noTrade: { calendarConnected: boolean; active: boolean; reason: string | null; scope: AssetEventView['engine']['scope']; filter: AssetEventView['filter']; currencies: string[] | null; nextHigh: AssetEventView['nextHigh']; upcoming: AssetEventView['upcoming'] };
  /** ATR/Intraday aus den Kerzen DIESER Quelle; SAFE-003 prüft die Engine global an BTC/ETH (USDT). */
  volatility: { atrPct: number | null; intradayMovePct: number | null; safe003: { btcMovePct: number | null; ethMovePct: number | null; btcMaxPct: number; ethMaxPct: number; assetMaxPct: number | null } };
  risk: {
    killSwitchActive: boolean;
    mode: string;
    riskPctPerTrade: number;
    maxLeverage: number;
    maxExposurePctPerAsset: number;
    dailyLossLimitPct: number;
    /** Summe Agent + Demo. */
    exposureNotional: number;
    openPositions: number;
    agent: { positions: number; notional: number };
    demo: { positions: number; notional: number };
  };
  llmConfigured: boolean;
};

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export async function buildAssetAnalysis(db: Db, userId: string, symbolRaw: string, venueRaw = 'binance'): Promise<AssetAnalysis> {
  const symbol = symbolRaw.trim().toUpperCase();
  const venue = venueRaw.trim().toLowerCase() || 'binance';
  const now = new Date();
  const profile = assetProfile(symbol, venue);
  // Funding/OI gibt es nur für Binance-Krypto-Paare (USDⓈ-M-Perps).
  const derivApplicable = venue === 'binance' && profile?.assetClass === 'crypto';

  const macro = await getMacroSnapshot(db);
  const [cotEntry] = await getCotSnapshot(db, symbol);
  const [deriv] = derivApplicable ? await getDerivativesSnapshot(db, [symbol]) : [];
  const events = await upcomingEvents(db, { days: 7 });
  const engineWindow = await loadNoTradeWindow(db, now);
  const ev = buildAssetEventView(
    events.map((e) => ({ title: e.title, currency: e.currency, importance: e.importance, scheduledAt: e.scheduledAt })),
    now,
    profile,
    engineWindow,
  );
  const settings = await ensureTradingSettings(db, userId);
  const agentRes = await db.execute(
    sql`SELECT count(*)::int AS n, coalesce(sum(qty::float * entry_price::float), 0)::float AS notional FROM positions WHERE symbol = ${symbol}`,
  );
  const demoRes = await db.execute(
    sql`SELECT count(*)::int AS n, coalesce(sum(qty::float * entry_price::float), 0)::float AS notional FROM demo_positions WHERE symbol = ${symbol} AND user_id = ${userId}`,
  );
  const agent = agentRes.rows[0] as { n: number; notional: number };
  const demo = demoRes.rows[0] as { n: number; notional: number };
  const derivFresh = Boolean(deriv?.fundingTs && now.getTime() - deriv.fundingTs.getTime() < 3 * 3_600_000);

  // Volatilität aus den Kerzen DIESER Quelle (ATR 14 auf 1h; Intraday = SAFE-003-Formel ab UTC-Tagesbeginn).
  const candles = await getOhlcv(db, { symbol, timeframe: '1h', venue, limit: 100 });
  const last = candles[candles.length - 1];
  const atrSeries = candles.length >= 15 ? atr(candles) : [];
  const atr14 = atrSeries[atrSeries.length - 1] ?? null;
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const todays = candles.filter((c) => c.ts >= dayStart);
  const btcMove = await loadIntradayMovePct(db, 'BTC/USDT', now);
  const ethMove = await loadIntradayMovePct(db, 'ETH/USDT', now);
  const assetMaxPct = profile?.base === 'BTC' && profile.assetClass === 'crypto' ? SAFE_003_BTC_INTRADAY_MAX_PCT : profile?.base === 'ETH' && profile.assetClass === 'crypto' ? SAFE_003_ETH_INTRADAY_MAX_PCT : null;
  const assetMove = todays.length > 0 ? intradayMovePct(todays) : null;

  return {
    symbol,
    venue,
    asOf: now.toISOString(),
    profile: profile ? { assetClass: profile.assetClass, base: profile.base, currencies: profile.currencies, quoteCurrency: profile.quoteCurrency } : null,
    macro: {
      connected: macro.fresh && macro.grs !== null,
      grs: macro.grs ? { score: round(macro.grs.score, 1), label: macro.grs.label } : null,
      vix: macro.vix?.value ?? null,
      dxy: macro.dxy?.value ?? null,
      us10y: macro.us10y?.value ?? null,
      asOf: macro.vix?.ts.toISOString() ?? null,
    },
    cot: cotEntry
      ? {
          applicable: true,
          connected: cotEntry.weeks > 0,
          market: cotEntry.market.label,
          inverse: cotEntry.inverse,
          status: cotEntry.weeks > 0 ? cotEntry.positioning.status : null,
          netRatio: cotEntry.weeks > 0 ? round(cotEntry.positioning.netRatio, 3) : null,
          percentile: cotEntry.weeks > 0 ? round(cotEntry.positioning.percentile, 2) : null,
          weekChange: cotEntry.weeks > 0 ? round(cotEntry.positioning.weekChange, 3) : null,
          reportDate: cotEntry.reportDate,
        }
      : { applicable: false, connected: false, market: null, inverse: false, status: null, netRatio: null, percentile: null, weekChange: null, reportDate: null },
    derivatives: {
      applicable: derivApplicable,
      connected: derivFresh,
      fundingRate: deriv?.fundingRate ?? null,
      openInterest: deriv?.openInterest ?? null,
      oiChangePct24h: deriv?.oiChangePct24h ?? null,
      asOf: deriv?.fundingTs?.toISOString() ?? null,
    },
    noTrade: {
      calendarConnected: events.length > 0,
      active: ev.engine.active,
      reason: ev.engine.reason,
      scope: ev.engine.scope,
      filter: ev.filter,
      currencies: ev.currencies,
      nextHigh: ev.nextHigh,
      upcoming: ev.upcoming,
    },
    volatility: {
      atrPct: atr14 !== null && last && last.close > 0 ? round((atr14 / last.close) * 100, 3) : null,
      intradayMovePct: assetMove === null ? null : round(assetMove, 2),
      safe003: {
        btcMovePct: btcMove === null ? null : round(btcMove, 2),
        ethMovePct: ethMove === null ? null : round(ethMove, 2),
        btcMaxPct: SAFE_003_BTC_INTRADAY_MAX_PCT,
        ethMaxPct: SAFE_003_ETH_INTRADAY_MAX_PCT,
        assetMaxPct,
      },
    },
    risk: {
      killSwitchActive: settings.killSwitchActive,
      mode: settings.mode,
      riskPctPerTrade: Number(settings.riskPctPerTrade),
      maxLeverage: Number(settings.maxLeverage),
      maxExposurePctPerAsset: Number(settings.maxExposurePctPerAsset),
      dailyLossLimitPct: Number(settings.dailyLossLimitPct),
      exposureNotional: round(agent.notional + demo.notional, 2),
      openPositions: agent.n + demo.n,
      agent: { positions: agent.n, notional: round(agent.notional, 2) },
      demo: { positions: demo.n, notional: round(demo.notional, 2) },
    },
    llmConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}
