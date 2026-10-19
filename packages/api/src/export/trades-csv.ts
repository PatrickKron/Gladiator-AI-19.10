/**
 * Steuer-/Trade-Export (10_ §6, §23 EStG): reiner CSV-Builder ohne DB-Zugriff.
 *
 * Format-Entscheidungen (bewusst, dokumentiert):
 * - Trennzeichen Semikolon (deutsches Excel öffnet das direkt).
 * - Dezimaltrenner PUNKT, kein Komma: Werte kommen 1:1 als `numeric`-Strings aus
 *   der DB (keine Float-Rundung, keine Locale-Umwandlung). Steuersoftware/Excel
 *   kann beim Import „Punkt als Dezimaltrenner" setzen.
 * - Zeitstempel als ISO-8601 in UTC; das Steuerjahr (Jahresfilter) wird dagegen
 *   nach deutscher Zeit (Europe/Berlin) bestimmt.
 * - Exportiert werden nur GESCHLOSSENE Trades (realisierter PnL); offene
 *   Positionen sind noch keine Veräußerung.
 * - Erste Zeile ist ein `#`-Hinweis: Paper-Trades sind simuliert und NICHT
 *   steuerrelevant — steuerlich zählen erst echte (Live-)Trades.
 */

export type ExportTrade = {
  symbol: string;
  direction: 'long' | 'short';
  venue: string;
  entryTs: Date;
  exitTs: Date | null;
  /** numeric-Strings aus der DB (Präzision bleibt erhalten). */
  qty: string;
  entryPrice: string;
  exitPrice: string | null;
  grossPnl: string | null;
  fee: string;
  funding: string;
  netPnl: string | null;
  mode: 'paper' | 'live';
};

export const TRADES_CSV_HEADER = [
  'Symbol',
  'Richtung',
  'Eröffnet',
  'Geschlossen',
  'Haltedauer (Tage)',
  'Menge',
  'Einstieg',
  'Ausstieg',
  'Brutto-PnL',
  'Gebühren',
  'Funding',
  'Netto-PnL',
  'Modus',
  'Börse',
  'Haltefrist > 1 Jahr',
] as const;

const NUMERIC = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/**
 * Ein CSV-Feld: Quoting bei ; " CR/LF (Anführungszeichen verdoppelt) und
 * Schutz vor Formel-Injection — Text, der mit = + @ Tab (oder - ohne Zahl)
 * beginnt, bekommt ein führendes Apostroph, damit Excel ihn nicht ausführt.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+@\t\r-]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  if (/[;"\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Haltedauer in Tagen, 2 Nachkommastellen. */
export function holdingDays(entry: Date, exit: Date): string {
  return ((exit.getTime() - entry.getTime()) / 86_400_000).toFixed(2);
}

/**
 * §23 EStG: steuerfrei, wenn zwischen Anschaffung und Veräußerung MEHR als ein
 * Jahr liegt — gerechnet über den Jahrestag (Kalender), nicht über 365 Tage.
 */
export function holdingOverOneYear(entry: Date, exit: Date): boolean {
  const anniversary = new Date(entry.getTime());
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  return exit.getTime() > anniversary.getTime();
}

const berlinYear = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' });

/** Steuerjahr eines Zeitpunkts nach deutscher Zeit. */
export function taxYear(d: Date): number {
  return Number(berlinYear.format(d));
}

function notice(trades: ExportTrade[]): string {
  const hasLive = trades.some((t) => t.mode === 'live');
  return hasLive
    ? '# Hinweis: Enthält Live-Trades (steuerrelevant) — Paper-Trades sind simuliert und nicht steuerrelevant. Keine Steuerberatung; Werte mit Punkt als Dezimaltrenner, Zeiten in UTC.'
    : '# Hinweis: Paper-Trades sind simuliert und nicht steuerrelevant — steuerlich zählen erst echte Live-Trades. Keine Steuerberatung; Werte mit Punkt als Dezimaltrenner, Zeiten in UTC.';
}

/** CSV aus Trades; optional nur Veräußerungen im Steuerjahr `year`. */
export function buildTradesCsv(trades: ExportTrade[], opts: { year?: number } = {}): string {
  const closed = trades
    .filter((t): t is ExportTrade & { exitTs: Date } => t.exitTs !== null)
    .filter((t) => opts.year === undefined || taxYear(t.exitTs) === opts.year)
    .sort((a, b) => a.exitTs.getTime() - b.exitTs.getTime());

  const lines = [notice(closed), TRADES_CSV_HEADER.map(csvCell).join(';')];
  for (const t of closed) {
    lines.push(
      [
        t.symbol,
        t.direction,
        t.entryTs.toISOString(),
        t.exitTs.toISOString(),
        holdingDays(t.entryTs, t.exitTs),
        t.qty,
        t.entryPrice,
        t.exitPrice,
        t.grossPnl,
        t.fee,
        t.funding,
        t.netPnl,
        t.mode,
        t.venue,
        holdingOverOneYear(t.entryTs, t.exitTs) ? 'ja' : 'nein',
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  return `${lines.join('\n')}\n`;
}
