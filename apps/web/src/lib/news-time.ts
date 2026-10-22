/**
 * Zeitangaben für News (Patricks Mängelliste 2026-10-22, Punkt 7: „nicht mal Datum und
 * Uhrzeit“): jede Meldung bekommt eine relative Angabe („vor 2 Std.“) UND die absolute
 * Zeit; die Liste wird nach Tagen gruppiert (Heute / Gestern / Wochentag, Datum). Rein,
 * testbar; Formate über die App-Locale.
 */

export type NewsWhen = { relative: string; absolute: string; day: string };

const HOUR = 3_600_000;

/** Tages-Schlüssel in lokaler Zeit (YYYY-MM-DD). */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function newsWhen(publishedAt: string | Date, now: Date, locale: string, labels: { today: string; yesterday: string }): NewsWhen {
  const d = new Date(publishedAt);
  const diffMs = now.getTime() - d.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  let relative: string;
  if (diffMs < HOUR) relative = rtf.format(-Math.max(1, Math.round(diffMs / 60_000)), 'minute');
  else if (diffMs < 24 * HOUR) relative = rtf.format(-Math.round(diffMs / HOUR), 'hour');
  else relative = rtf.format(-Math.round(diffMs / (24 * HOUR)), 'day');
  const absolute = d.toLocaleString(locale, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const key = localDayKey(d);
  const day = key === localDayKey(now) ? labels.today : key === localDayKey(new Date(now.getTime() - 24 * HOUR)) ? labels.yesterday : d.toLocaleDateString(locale, { weekday: 'long', day: '2-digit', month: 'long' });
  return { relative, absolute, day };
}

/** Gruppiert (bereits nach Zeit sortierte) Meldungen nach lokalem Tag — Reihenfolge bleibt. */
export function groupByDay<N extends { publishedAt: string | Date }>(items: N[], now: Date, locale: string, labels: { today: string; yesterday: string }): { day: string; items: N[] }[] {
  const out: { day: string; items: N[] }[] = [];
  for (const n of items) {
    const { day } = newsWhen(n.publishedAt, now, locale, labels);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(n);
    else out.push({ day, items: [n] });
  }
  return out;
}
