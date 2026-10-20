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
