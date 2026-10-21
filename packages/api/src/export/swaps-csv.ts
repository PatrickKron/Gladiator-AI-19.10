import { csvCell, taxYear } from './trades-csv.js';

/**
 * Steuer-Export der Wallet-Swaps (§23 EStG: jeder Tausch Krypto→Krypto ist eine
 * Veräußerung). Reiner CSV-Builder wie `trades-csv.ts` (Semikolon, Punkt als
 * Dezimaltrenner, UTC, Formel-Schutz). Ehrlich über die Grenzen: Werte in USD
 * zum Ausführungszeitpunkt, realisierter Gewinn nach Durchschnittskosten — das
 * Finanzamt erwartet i. d. R. FIFO in EUR; dafür ist die Datei als Rohliste für
 * ein Krypto-Steuer-Tool gedacht (jede Zeile mit Token-Adresse und Tx).
 * Nur AUSGEFÜHRTE Swaps (fehlgeschlagen/unklar = keine Veräußerung bzw. noch offen).
 */

export type ExportSwap = {
  ts: Date;
  wallet: string;
  chain: string;
  mode: 'paper' | 'live';
  side: 'buy' | 'sell';
  status: 'filled' | 'pending' | 'failed';
  inAmount: string;
  inSymbol: string;
  inToken: string;
  outAmount: string;
  outSymbol: string;
  outToken: string;
  /** numeric-Strings aus der DB */
  valueUsd: string | null;
  feeUsd: string | null;
  realizedPnlUsd: string | null;
  txHash: string | null;
  aggregator: string;
};

export const SWAPS_CSV_HEADER = [
  'Zeitpunkt (UTC)',
  'Wallet',
  'Kette',
  'Modus',
  'Art',
  'Gegeben Menge',
  'Gegeben Token',
  'Gegeben Adresse',
  'Erhalten Menge',
  'Erhalten Token',
  'Erhalten Adresse',
  'Wert (USD)',
  'Netzwerkgebühr (USD)',
  'Realisierter Gewinn (USD, Durchschnittskosten)',
  'EZB-Kurs (USD je EUR)',
  'Wert (EUR)',
  'Netzwerkgebühr (EUR)',
  'Transaktion',
  'Aggregator',
] as const;

/** EUR-Umrechnung: USD je 1 EUR am Tag des Swaps (EZB-Referenzkurs) oder null (nicht verfügbar). */
export type EurRateFn = (ts: Date) => number | null;

function notice(swaps: ExportSwap[], eur: { available: boolean }): string {
  const live = swaps.some((s) => s.mode === 'live');
  const eurNote = eur.available
    ? 'EUR-Werte zum EZB-Referenzkurs des Tages (Wochenende/Feiertag: letzter Kurs davor)'
    : 'EZB-Kurse waren nicht abrufbar — EUR-Spalten leer, bitte später erneut exportieren';
  return `# Hinweis: ${live ? 'Enthält echte Swaps (steuerrelevant: jeder Tausch ist eine Veräußerung) — ' : ''}Paper-Swaps sind simuliert und nicht steuerrelevant. Werte in USD zum Ausführungszeitpunkt; ${eurNote}. Erhaltene Menge laut bestätigtem Angebot (tatsächlich mindestens die Mindestmenge, siehe Transaktion). Gewinn nach Durchschnittskosten in USD; das Finanzamt erwartet i. d. R. FIFO in EUR — Datei in ein Krypto-Steuer-Tool importieren. Keine Steuerberatung; Punkt als Dezimaltrenner, Zeiten in UTC.`;
}

const toEur = (usd: string | null, rate: number | null): string | null => (usd === null || rate === null ? null : (Number(usd) / rate).toFixed(4));

/** CSV der ausgeführten Swaps; optional nur das Steuerjahr `year` (deutsche Zeit). */
export function buildSwapsCsv(swaps: ExportSwap[], opts: { year?: number; eurRate?: EurRateFn | null } = {}): string {
  const done = swaps
    .filter((s) => s.status === 'filled')
    .filter((s) => opts.year === undefined || taxYear(s.ts) === opts.year)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const lines = [notice(done, { available: Boolean(opts.eurRate) }), SWAPS_CSV_HEADER.map(csvCell).join(';')];
  for (const s of done) {
    const rate = opts.eurRate ? opts.eurRate(s.ts) : null;
    lines.push(
      [
        s.ts.toISOString(),
        s.wallet,
        s.chain,
        s.mode,
        s.side === 'buy' ? 'Kauf' : 'Verkauf',
        s.inAmount,
        s.inSymbol,
        s.inToken,
        s.outAmount,
        s.outSymbol,
        s.outToken,
        s.valueUsd,
        s.feeUsd,
        s.realizedPnlUsd,
        rate,
        toEur(s.valueUsd, rate),
        toEur(s.feeUsd, rate),
        s.txHash,
        s.aggregator,
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  return `${lines.join('\n')}\n`;
}
