import { validateDrawingPoints, type DrawingKind, type DrawingPoint } from '@gladiator/core/drawings';

/**
 * Reine Logik der Chart-Zeichenwerkzeuge (Plan §5): Abbildung Zeit ↔ Kerzen-
 * Index, Platzier-Logik der Klicks und Treffer-Test fürs Löschen.
 *
 * WARUM Zeit ↔ „logischer Index" statt timeToCoordinate: lightweight-charts (4 wie 5)
 * kennt nur Zeiten, die als Kerze existieren. Zeichnungen sind aber
 * Timeframe-unabhängig (z. B. 1h-Anker im 4h-Chart oder Anker außerhalb des
 * geladenen Fensters). Wir rechnen die Zeit deshalb in einen GEBROCHENEN
 * Kerzen-Index um (Interpolation zwischen Kerzen, Extrapolation am Rand) und
 * lassen den Chart daraus per logicalToCoordinate die x-Position bestimmen —
 * dadurch bleibt alles beim Pannen/Zoomen und TF-Wechsel korrekt.
 */

export type DrawingTool = 'none' | DrawingKind | 'delete' | 'move';

/** Index der letzten Kerze mit times[i] <= t (times aufsteigend, t im Bereich). */
function floorIndex(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Unix-Sekunden → gebrochener Kerzen-Index (null ohne ausreichende Daten). */
export function timeToLogical(times: readonly number[], t: number): number | null {
  const n = times.length;
  if (n === 0 || !Number.isFinite(t)) return null;
  if (n === 1) return t === times[0] ? 0 : null;
  const first = times[0]!;
  const last = times[n - 1]!;
  if (t <= first) return (t - first) / (times[1]! - first);
  if (t >= last) return n - 1 + (t - last) / (last - times[n - 2]!);
  const i = floorIndex(times, t);
  const t0 = times[i]!;
  return i + (t - t0) / (times[i + 1]! - t0);
}

/** Gebrochener Kerzen-Index → Unix-Sekunden (ganzzahlig gerundet). */
export function logicalToTime(times: readonly number[], logical: number): number | null {
  const n = times.length;
  if (n === 0 || !Number.isFinite(logical)) return null;
  if (n === 1) return times[0]!;
  let t: number;
  if (logical <= 0) t = times[0]! + logical * (times[1]! - times[0]!);
  else if (logical >= n - 1) t = times[n - 1]! + (logical - (n - 1)) * (times[n - 1]! - times[n - 2]!);
  else {
    const i = Math.floor(logical);
    t = times[i]! + (logical - i) * (times[i + 1]! - times[i]!);
  }
  return Math.round(t);
}

/** Chart-Klick (logischer Index + Preis) → speicherbarer Anker; Preis auf 8 signifikante Stellen. */
export function pointFromChart(
  times: readonly number[],
  logical: number | null,
  price: number | null,
): DrawingPoint | null {
  if (logical == null || price == null || !Number.isFinite(price) || price <= 0) return null;
  const time = logicalToTime(times, logical);
  if (time == null || time <= 0) return null;
  return { time, price: Number(price.toPrecision(8)) };
}

/**
 * Ein Klick im Zeichenmodus. Horizontale: sofort fertig. Trend/Fibonacci:
 * erster Klick merkt den Start-Anker, zweiter erzeugt — ein ungültiger zweiter
 * Klick (gleiche Zeit bzw. gleicher Preis) wird ignoriert, der Start bleibt.
 */
export function applyDrawingClick(
  tool: DrawingTool,
  pending: DrawingPoint | null,
  p: DrawingPoint,
): { pending: DrawingPoint | null; create: { kind: DrawingKind; points: DrawingPoint[] } | null } {
  if (tool === 'none' || tool === 'delete' || tool === 'move') return { pending: null, create: null };
  if (tool === 'hline') return { pending: null, create: { kind: 'hline', points: [p] } };
  if (!pending) return { pending: p, create: null };
  const points = [pending, p];
  if (validateDrawingPoints(tool, points) !== null) return { pending, create: null };
  return { pending: null, create: { kind: tool, points } };
}

export type Px = { x: number; y: number };
/** Zeichnung in Pixel-Koordinaten (vom Chart projiziert) — Grundlage des Treffer-Tests. */
export type PixelShape =
  | { kind: 'hline'; y: number }
  | { kind: 'segment'; a: Px; b: Px }
  | { kind: 'fib'; x1: number; x2: number; ys: number[] };

export function distanceToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

export function shapeDistance(shape: PixelShape, p: Px): number {
  switch (shape.kind) {
    case 'hline':
      return Math.abs(p.y - shape.y);
    case 'segment':
      return distanceToSegment(p, shape.a, shape.b);
    case 'fib': {
      const x1 = Math.min(shape.x1, shape.x2);
      const x2 = Math.max(shape.x1, shape.x2);
      let best = Number.POSITIVE_INFINITY;
      for (const y of shape.ys) best = Math.min(best, distanceToSegment(p, { x: x1, y }, { x: x2, y }));
      return best;
    }
  }
}

/** Id der nächstgelegenen Zeichnung innerhalb `tolerance` Pixel, sonst null. */
export function pickDrawing(shapes: readonly { id: string; shape: PixelShape }[], p: Px, tolerance: number): string | null {
  let bestId: string | null = null;
  let best = tolerance;
  for (const s of shapes) {
    const d = shapeDistance(s.shape, p);
    if (d <= best) {
      best = d;
      bestId = s.id;
    }
  }
  return bestId;
}

/**
 * Zeichnung verschieben: jeder Anker wandert um dLogical Kerzen (über die
 * gebrochene Kerzen-Position, damit es auch zwischen/hinter Kerzen stimmt) und
 * dPrice. Ungültig (Preis ≤ 0, keine Kerzen) → null, dann wird nichts gespeichert.
 */
export function translatePoints(
  times: readonly number[],
  points: readonly DrawingPoint[],
  dLogical: number,
  dPrice: number,
): DrawingPoint[] | null {
  const out: DrawingPoint[] = [];
  for (const p of points) {
    const logical = timeToLogical(times, p.time);
    if (logical == null) return null;
    const time = logicalToTime(times, logical + dLogical);
    const price = Number((p.price + dPrice).toPrecision(8));
    if (time == null || time <= 0 || !(price > 0)) return null;
    out.push({ time, price });
  }
  return out;
}
