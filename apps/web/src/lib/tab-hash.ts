/**
 * Aktiven Tab im Location-Hash halten (P1.8), z. B. `#/trading?tab=risiko`.
 * Rein & testbar; unbekannter Tab → Fallback.
 */
export function parseTab(hash: string, valid: readonly string[], fallback: string): string {
  const q = hash.indexOf('?');
  if (q < 0) return fallback;
  const v = new URLSearchParams(hash.slice(q + 1)).get('tab');
  return v && valid.includes(v) ? v : fallback;
}

export function buildTabHash(base: string, tab: string): string {
  return `${base}?tab=${tab}`;
}
