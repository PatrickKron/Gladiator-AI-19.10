import { eventRelevantForAsset, noTradeScope, type AssetEventLike, type AssetProfile } from '@gladiator/core';
import { classifyEvent, type EventCategory } from '@gladiator/market-data';
import { NO_TRADE_DEFAULTS, type NoTradeWindow } from '@gladiator/risk';

/**
 * Termine je Asset (Chart-Seite → Analyse/Risiko): High-Impact-Termine, die das GEWÄHLTE Asset
 * betreffen (Währung aus `assetProfile`, Relevanz aus `classifyEvent`) — plus der ehrliche
 * Zustand der Engine-Sperre. Die Engine (`loadNoTradeWindow`) sperrt GLOBAL: ist ein Fenster
 * aktiv, steht es hier IMMER, auch wenn der auslösende Termin dieses Asset nicht betrifft
 * (`scope: 'global'`). Rein — die DB-Abfragen macht der Aufrufer.
 */

export type CalendarRow = { title: string; currency: string | null; importance: number | null; scheduledAt: Date };

export type AssetEventView = {
  /** `asset` = nach Asset-Währungen gefiltert; `all` = Asset/Währung unbekannt → alle High-Impact. */
  filter: 'asset' | 'all';
  currencies: string[] | null;
  engine: { active: boolean; reason: string | null; scope: 'none' | 'asset' | 'global' };
  nextHigh: { title: string; currency: string | null; scheduledAt: string } | null;
  upcoming: { title: string; currency: string | null; importance: number | null; scheduledAt: string; category: EventCategory }[];
};

function classified(e: CalendarRow): AssetEventLike & { category: EventCategory } {
  const impact = classifyEvent({ title: e.title, currency: e.currency, importance: e.importance });
  return { currency: e.currency, importance: e.importance, scope: impact.scope, cryptoRelevance: impact.cryptoRelevance, equityRelevance: impact.equityRelevance, category: impact.category };
}

export function buildAssetEventView(events: CalendarRow[], now: Date, profile: AssetProfile | null, engineWindow: NoTradeWindow | null, limit = 8): AssetEventView {
  // Laufender Termin bleibt sichtbar, solange das Nach-Fenster der Engine gilt.
  const from = now.getTime() - NO_TRADE_DEFAULTS.afterMin * 60_000;
  const relevant = events
    .filter((e) => e.scheduledAt.getTime() >= from)
    .map((e) => ({ e, c: classified(e) }))
    .filter(({ c }) => eventRelevantForAsset(profile, c))
    .sort((a, b) => a.e.scheduledAt.getTime() - b.e.scheduledAt.getTime());
  const next = relevant.find(({ e }) => e.scheduledAt.getTime() >= now.getTime());
  const active = Boolean(engineWindow?.active);
  return {
    filter: profile && profile.currencies !== null ? 'asset' : 'all',
    currencies: profile?.currencies ?? null,
    engine: {
      active,
      reason: active ? engineWindow!.reason : null,
      scope: active ? noTradeScope(classified(engineWindow!.event), profile) : 'none',
    },
    nextHigh: next ? { title: next.e.title, currency: next.e.currency, scheduledAt: next.e.scheduledAt.toISOString() } : null,
    upcoming: relevant.slice(0, limit).map(({ e, c }) => ({ title: e.title, currency: e.currency, importance: e.importance, scheduledAt: e.scheduledAt.toISOString(), category: c.category })),
  };
}
