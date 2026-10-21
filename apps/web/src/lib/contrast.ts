/**
 * Kontrast nach WCAG 2.x (relative Luminanz, Verhältnis (L1+0,05)/(L2+0,05)).
 * Rein und getestet — der Kontrast-Audit (contrast.test.ts) prüft die Tokens
 * aus styles.css gegen AA (4,5:1 für Fließtext, 3:1 für große Schrift/UI).
 */

export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** `#rgb`/`#rrggbb` → [r, g, b] 0–255. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Keine Hex-Farbe: ${hex}`);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Farbe mit Deckkraft `alpha` über `base` — so sieht der Browser einen `color-mix(... x%, transparent)`-Hintergrund. */
export function over(color: string, alpha: number, base: string): string {
  const c = parseHex(color);
  const b = parseHex(base);
  const mix = c.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)));
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
