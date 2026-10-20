/**
 * Chart-Zeichnungen (Plan §5 „Chart: Zeichenwerkzeuge") — geteilter Vertrag
 * zwischen API (Validierung/Persistenz) und Web (Rendering).
 *
 * Zeichnungen sind Zeit/Preis-verankert (Unix-Sekunden + Preis), NICHT an Kerzen-
 * Indizes gebunden — dadurch bleiben sie beim Timeframe-Wechsel korrekt.
 * Bewusst OHNE zod-Import: der Browser importiert dieses Modul direkt
 * (`@gladiator/core/drawings`), ohne zod mitzubündeln.
 */

export const DRAWING_KINDS = ['hline', 'trend', 'fib'] as const;
export type DrawingKind = (typeof DRAWING_KINDS)[number];

/** Anzahl Anker je Art: Horizontale = 1 Preis, Trendlinie/Fibonacci = 2 Anker. */
export const DRAWING_POINT_COUNT: Readonly<Record<DrawingKind, number>> = { hline: 1, trend: 2, fib: 2 };

/** Fibonacci-Retracement-Stufen (aufsteigend). */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** Obergrenze je Nutzer + Symbol (Schutz vor unbegrenztem Wachstum). */
export const MAX_DRAWINGS_PER_SYMBOL = 200;

/** Plausibler Zeitbereich (Unix-SEKUNDEN): > 0 und < Jahr ~5138 — Millisekunden fallen heraus. */
export const MAX_DRAWING_TIME = 100_000_000_000;

export interface DrawingPoint {
  /** Unix-Sekunden (UTC). */
  time: number;
  price: number;
}

export interface DrawingStyle {
  color?: string;
  lineWidth?: number;
}

export function isDrawingKind(v: unknown): v is DrawingKind {
  return typeof v === 'string' && (DRAWING_KINDS as readonly string[]).includes(v);
}

/**
 * Prüft die Anker einer Zeichnung. Liefert `null` bei Gültigkeit, sonst eine
 * deutsche Fehlermeldung (wird 1:1 an den Client gereicht).
 */
export function validateDrawingPoints(kind: DrawingKind, points: readonly DrawingPoint[]): string | null {
  if (!isDrawingKind(kind)) return `Unbekannte Zeichnungsart: ${String(kind)}`;
  const need = DRAWING_POINT_COUNT[kind];
  if (points.length !== need) return `${kind} braucht genau ${need} Anker (erhalten: ${points.length}).`;
  for (const p of points) {
    if (!Number.isFinite(p.time) || p.time <= 0 || p.time >= MAX_DRAWING_TIME) {
      return 'Anker-Zeit muss eine Unix-Zeit in Sekunden sein.';
    }
    if (!Number.isFinite(p.price) || p.price <= 0) return 'Anker-Preis muss eine endliche Zahl > 0 sein.';
  }
  if (kind === 'trend' && points[0]!.time === points[1]!.time) {
    return 'Trendlinie: beide Anker haben dieselbe Zeit.';
  }
  if (kind === 'fib' && points[0]!.price === points[1]!.price) {
    return 'Fibonacci: beide Anker haben denselben Preis.';
  }
  return null;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Stil prüfen (optional): nur Hex-Farbe + ganzzahlige Linienbreite 1..4. */
export function validateDrawingStyle(style: DrawingStyle | null | undefined): string | null {
  if (style == null) return null;
  if (style.color !== undefined && !HEX_COLOR.test(style.color)) return 'Farbe muss #RRGGBB sein.';
  if (style.lineWidth !== undefined && (!Number.isInteger(style.lineWidth) || style.lineWidth < 1 || style.lineWidth > 4)) {
    return 'Linienbreite muss 1 bis 4 sein.';
  }
  return null;
}

/**
 * Fibonacci-Preise zwischen Start- und End-Anker (TradingView-Konvention):
 * Level 0 liegt am END-Anker (zweiter Klick), Level 1 am START-Anker.
 * preis(level) = end + (start − end) · level
 */
export function fibLevelPrices(start: DrawingPoint, end: DrawingPoint): { level: number; price: number }[] {
  return FIB_LEVELS.map((level) => ({ level, price: end.price + (start.price - end.price) * level }));
}
