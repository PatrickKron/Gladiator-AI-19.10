/**
 * No-Trade-Fenster (09_ §3.7): rund um High-Impact-Makro-Events (CPI,
 * Leitzins, NFP …) werden keine NEUEN Orders eröffnet — bestehende
 * Schutz-Orders laufen selbstverständlich weiter.
 * Reine Funktion: Events + Zeitpunkt rein, Fenster raus.
 */

export type CalendarEventLike = {
  title: string;
  currency: string | null;
  /** 1 = niedrig … 3 = hoch. */
  importance: number | null;
  scheduledAt: Date;
};

export type NoTradeWindow = {
  active: boolean;
  reason: string;
  event: CalendarEventLike;
};

export const NO_TRADE_DEFAULTS = { beforeMin: 30, afterMin: 30 };

/** Liefert das aktive No-Trade-Fenster (nächstliegendes High-Impact-Event) oder null. */
export function noTradeWindowFor(
  events: CalendarEventLike[],
  now: Date,
  opts: { beforeMin: number; afterMin: number } = NO_TRADE_DEFAULTS,
): NoTradeWindow | null {
  const hits = events
    .filter((e) => (e.importance ?? 0) >= 3)
    .filter((e) => {
      const delta = e.scheduledAt.getTime() - now.getTime();
      return delta <= opts.beforeMin * 60_000 && delta >= -opts.afterMin * 60_000;
    })
    .sort((a, b) => Math.abs(a.scheduledAt.getTime() - now.getTime()) - Math.abs(b.scheduledAt.getTime() - now.getTime()));

  const nearest = hits[0];
  if (!nearest) return null;
  const hh = String(nearest.scheduledAt.getUTCHours()).padStart(2, '0');
  const mm = String(nearest.scheduledAt.getUTCMinutes()).padStart(2, '0');
  return {
    active: true,
    reason: `${nearest.title} (${nearest.currency ?? '—'}) um ${hh}:${mm} UTC`,
    event: nearest,
  };
}
