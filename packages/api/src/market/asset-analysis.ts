import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { getCotSnapshot, getDerivativesSnapshot, getMacroSnapshot, upcomingEvents, type CotStatus } from '@gladiator/market-data';
import { noTradeWindowFor } from '@gladiator/risk';
import { ensureTradingSettings } from '../routers/settings.js';

/**
 * Asset-Analyse auf einen Klick (Patricks Mängelliste 2026-10-22, Punkt 6): die drei Blicke
 * Oracle (Makro & Regime), Shadow (Positionierung: Funding, Open Interest, COT) und Sentinel
 * (Risiko-Wächter: No-Trade-Fenster, Kill-Switch, Limits, Exposure) für GENAU ein Asset —
 * alles aus echten, bereits synchronisierten Daten. Fehlt eine Quelle, steht ehrlich
 * `connected: false`; nichts wird geschätzt. Seite UND Gladiator-Chat nutzen diese Funktion.
 */
export type AssetAnalysis = {
  symbol: string;
  asOf: string;
  macro: { connected: boolean; grs: { score: number; label: 'risk-on' | 'neutral' | 'risk-off' } | null; vix: number | null; dxy: number | null; us10y: number | null; asOf: string | null };
  cot: { applicable: boolean; connected: boolean; market: string | null; status: CotStatus | null; netRatio: number | null; percentile: number | null; weekChange: number | null; reportDate: string | null };
  derivatives: { connected: boolean; fundingRate: number | null; openInterest: number | null; oiChangePct24h: number | null; asOf: string | null };
  noTrade: { calendarConnected: boolean; active: boolean; reason: string | null; nextHigh: { title: string; currency: string | null; scheduledAt: string } | null };
  risk: { killSwitchActive: boolean; mode: string; riskPctPerTrade: number; maxLeverage: number; maxExposurePctPerAsset: number; dailyLossLimitPct: number; exposureNotional: number; openPositions: number };
  llmConfigured: boolean;
};

export async function buildAssetAnalysis(db: Db, userId: string, symbolRaw: string): Promise<AssetAnalysis> {
  const symbol = symbolRaw.toUpperCase();
  const now = new Date();

  const macro = await getMacroSnapshot(db);
  const [cotEntry] = await getCotSnapshot(db, symbol);
  const [deriv] = await getDerivativesSnapshot(db, [symbol]);
  const events = await upcomingEvents(db, { days: 7 });
  const noTrade = noTradeWindowFor(
    events.map((e) => ({ title: e.title, currency: e.currency, importance: e.importance, scheduledAt: e.scheduledAt })),
    now,
  );
  const nextHigh = events
    .filter((e) => (e.importance ?? 0) >= 3 && e.scheduledAt.getTime() >= now.getTime())
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0];
  const settings = await ensureTradingSettings(db, userId);
  const pos = await db.execute(
    sql`SELECT count(*)::int AS n, coalesce(sum(qty::float * entry_price::float), 0)::float AS notional FROM positions WHERE symbol = ${symbol}`,
  );
  const posRow = pos.rows[0] as { n: number; notional: number };
  const derivFresh = Boolean(deriv?.fundingTs && now.getTime() - deriv.fundingTs.getTime() < 3 * 3_600_000);

  return {
    symbol,
    asOf: now.toISOString(),
    macro: {
      connected: macro.fresh && macro.grs !== null,
      grs: macro.grs ? { score: Math.round(macro.grs.score * 10) / 10, label: macro.grs.label } : null,
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
          status: cotEntry.weeks > 0 ? cotEntry.positioning.status : null,
          netRatio: cotEntry.weeks > 0 ? Math.round(cotEntry.positioning.netRatio * 1000) / 1000 : null,
          percentile: cotEntry.weeks > 0 ? Math.round(cotEntry.positioning.percentile * 100) / 100 : null,
          weekChange: cotEntry.weeks > 0 ? Math.round(cotEntry.positioning.weekChange * 1000) / 1000 : null,
          reportDate: cotEntry.reportDate,
        }
      : { applicable: false, connected: false, market: null, status: null, netRatio: null, percentile: null, weekChange: null, reportDate: null },
    derivatives: {
      connected: derivFresh,
      fundingRate: deriv?.fundingRate ?? null,
      openInterest: deriv?.openInterest ?? null,
      oiChangePct24h: deriv?.oiChangePct24h ?? null,
      asOf: deriv?.fundingTs?.toISOString() ?? null,
    },
    noTrade: {
      calendarConnected: events.length > 0,
      active: Boolean(noTrade?.active),
      reason: noTrade?.active ? noTrade.reason : null,
      nextHigh: nextHigh ? { title: nextHigh.title, currency: nextHigh.currency, scheduledAt: nextHigh.scheduledAt.toISOString() } : null,
    },
    risk: {
      killSwitchActive: settings.killSwitchActive,
      mode: settings.mode,
      riskPctPerTrade: Number(settings.riskPctPerTrade),
      maxLeverage: Number(settings.maxLeverage),
      maxExposurePctPerAsset: Number(settings.maxExposurePctPerAsset),
      dailyLossLimitPct: Number(settings.dailyLossLimitPct),
      exposureNotional: Math.round(posRow.notional * 100) / 100,
      openPositions: posRow.n,
    },
    llmConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}
