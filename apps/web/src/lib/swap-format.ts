/**
 * Anzeige-Helfer fürs Wallet-Trading (rein, getestet): USD-Beträge von
 * Meme-Coin-Preisen (0,0000123 $) bis Marktkapitalisierung (1,2 Mrd. $),
 * Slippage-Auswahl bis zur eigenen Obergrenze, Gate-Gründe → i18n-Keys.
 */

export function fmtUsd(n: number, locale: string, compact = false): string {
  if (!Number.isFinite(n)) return '—';
  if (compact) return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(n);
  const abs = Math.abs(n);
  // kleine Preise mit signifikanten Stellen statt „0,00 $"
  if (abs > 0 && abs < 0.01) {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }).format(n);
  }
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(n);
}

/** Token-Mengen (Dezimal-String) lesbar: Tausender-Trennung, kleine Mengen mit signifikanten Stellen. */
export function fmtAmount(amount: string, locale: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  if (n !== 0 && Math.abs(n) < 0.0001) return new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 }).format(n);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(n) >= 1_000 ? 2 : 6 }).format(n);
}

/** Nachkommastellen für Chart-Preise: 4 signifikante Stellen bei kleinen Preisen (0,00002134), max. 12. */
export function pricePrecision(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return 2;
  if (price >= 1) return price >= 1_000 ? 2 : 4;
  return Math.min(12, Math.ceil(-Math.log10(price)) + 3);
}

const SLIPPAGE_STEPS = [10, 50, 100, 300, 500, 1_000, 1_500, 3_000, 5_000];

/** Slippage-Schnellwahl: Standardstufen bis zur eigenen Obergrenze, die Obergrenze selbst immer dabei. */
export function slippageChoices(maxBps: number): number[] {
  const steps = SLIPPAGE_STEPS.filter((b) => b < maxBps);
  return [...steps, maxBps];
}

export function fmtPct(pct: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(pct)} %`;
}

export function bpsLabel(bps: number, locale: string): string {
  return fmtPct(bps / 100, locale);
}

export function swapReasonKey(reason: string): string {
  return `swap.reason_${reason}`;
}

/** Alter des Pools, grob („vor 3 Std.“) — Intl übernimmt die Sprache. */
export function poolAge(iso: string | null, lang: string, now = Date.now()): string {
  if (!iso) return '—';
  const sec = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(sec)) return '—';
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always', style: 'short' });
  if (sec < 3600) return rtf.format(-Math.max(1, Math.round(sec / 60)), 'minute');
  if (sec < 86_400) return rtf.format(-Math.round(sec / 3600), 'hour');
  return rtf.format(-Math.round(sec / 86_400), 'day');
}

/**
 * „Einsatz zurückholen“ (Trojan: „Sell Initials“): Anteil des Bestands in %,
 * dessen Verkauf den Einstand zurückbringt — mit 1 % Puffer für Pool-Gebühr
 * und Preis-Einfluss, auf 0,01 % aufgerundet. Nur sinnvoll im Gewinn; sonst
 * null (dann wäre es ein Komplettverkauf).
 */
export function initialsPercent(costUsd: number | null, valueUsd: number | null): number | null {
  if (costUsd === null || valueUsd === null || !(costUsd > 0) || !(valueUsd > costUsd)) return null;
  const pct = Math.ceil(((costUsd * 1.01) / valueUsd) * 10_000) / 100;
  return pct >= 100 ? null : pct;
}

/** Gewinn/Verlust in % des Einstands; ohne Einstand oder Wert null (nie 0 geraten). */
export function pnlPercent(pnlUsd: number | null, costUsd: number | null): number | null {
  if (pnlUsd === null || costUsd === null || !(costUsd > 0) || !Number.isFinite(pnlUsd)) return null;
  return (pnlUsd / costUsd) * 100;
}

/** Durchschnittlicher Einstiegspreis je Token (USD), aus Einstand und Menge. */
export function avgEntryUsd(costUsd: number | null, amount: string): number | null {
  const n = Number(amount);
  if (costUsd === null || !(costUsd > 0) || !(n > 0)) return null;
  return costUsd / n;
}
