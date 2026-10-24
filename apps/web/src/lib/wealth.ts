/**
 * Vermögen (Welle B): Aufteilung und Verlauf aus echten Momentaufnahmen —
 * rein, getestet. Nichts wird erfunden: fehlende Teile (Kurs fehlt) bleiben
 * `null` und fallen aus der Summe, die Anzeige sagt es dazu.
 */

export type WealthPart = { key: string; usd: number | null };

export type WealthShare = { key: string; usd: number; share: number };

/** Anteile der bewertbaren Teile an ihrer Summe (0 … 1); leere/negative Summen → keine Anteile. */
export function allocation(parts: WealthPart[]): WealthShare[] {
  const valued = parts.filter((p): p is { key: string; usd: number } => p.usd !== null && Number.isFinite(p.usd) && p.usd > 0);
  const total = valued.reduce((s, p) => s + p.usd, 0);
  if (total <= 0) return [];
  return valued.map((p) => ({ key: p.key, usd: p.usd, share: p.usd / total }));
}

export type WealthRange = '7d' | '30d' | '90d' | 'all';
export const WEALTH_RANGES: WealthRange[] = ['7d', '30d', '90d', 'all'];

export type HistoryRow = { ts: string | Date; totalEur: number | null; demoEquityUsd: number | null; paperEquityUsd: number | null; realEquityUsd: number | null };

/**
 * Kurvenpunkte aus den Momentaufnahmen: EUR, wenn jede Zeile einen EUR-Wert
 * hat, sonst ehrlich die USD-Summe der Konten (Einheit wird mitgeliefert).
 */
export function wealthCurve(rows: HistoryRow[]): { points: { ts: string; equity: number }[]; unit: '€' | '$' } {
  const allEur = rows.length > 0 && rows.every((r) => r.totalEur !== null);
  const points = rows
    .map((r) => {
      const ts = typeof r.ts === 'string' ? r.ts : r.ts.toISOString();
      if (allEur) return { ts, equity: r.totalEur! };
      const usd = (r.demoEquityUsd ?? 0) + (r.paperEquityUsd ?? 0) + (r.realEquityUsd ?? 0);
      return { ts, equity: usd };
    })
    .filter((p) => Number.isFinite(p.equity));
  return { points, unit: allEur ? '€' : '$' };
}

/** Zeitfenster-Filter ab `now`; `all` = alles. */
export function rangeFilter<T extends { ts: string }>(points: T[], range: WealthRange, now: number): T[] {
  if (range === 'all') return points;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const from = now - days * 86_400_000;
  return points.filter((p) => Date.parse(p.ts) >= from);
}

/** Veränderung über das Fenster: absolut und in Prozent (null bei < 2 Punkten oder Start 0). */
export function rangeChange(points: { equity: number }[]): { abs: number; pct: number } | null {
  if (points.length < 2) return null;
  const first = points[0]!.equity;
  const last = points[points.length - 1]!.equity;
  if (!(first > 0)) return null;
  return { abs: last - first, pct: ((last - first) / first) * 100 };
}

/** Min/Max und Zeitraum eines sichtbaren Verlaufs (Punkte chronologisch) — unter dem Chart wie in v2; < 2 Punkte ⇒ null. */
export function rangeStats(points: { ts: string; equity: number }[]): { min: number; max: number; from: string; to: string } | null {
  if (points.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.equity < min) min = p.equity;
    if (p.equity > max) max = p.equity;
  }
  return { min, max, from: points[0]!.ts, to: points[points.length - 1]!.ts };
}
