/**
 * Historische EUR/USD-Referenzkurse der Europäischen Zentralbank (offizielle
 * Daten-API, ohne Schlüssel) — für die steuerliche Umrechnung von Swaps in Euro
 * zum Kurs des jeweiligen Tages. Wochenende/Feiertag: letzter Kurs davor
 * (höchstens 7 Tage zurück). Nicht erreichbar → Fehler; der Aufrufer zeigt die
 * EUR-Spalten dann ehrlich leer, nie geschätzt.
 */

type Fetch = typeof fetch;

export const ECB_EXR_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A';

/** CSV der EZB-API (`format=csvdata`) → Datum (JJJJ-MM-TT) → USD je 1 EUR. Spalten nach Namen, nicht nach Position. */
export function parseEcbCsv(csv: string): Map<string, number> {
  const lines = csv.trim().split(/\r?\n/);
  const head = (lines.shift() ?? '').split(',');
  const iDate = head.indexOf('TIME_PERIOD');
  const iVal = head.indexOf('OBS_VALUE');
  if (iDate < 0 || iVal < 0) throw new Error('EZB-Antwort ohne TIME_PERIOD/OBS_VALUE.');
  const out = new Map<string, number>();
  for (const line of lines) {
    const cells = line.split(',');
    const date = cells[iDate];
    const v = Number(cells[iVal]);
    // Plausibel: EUR/USD lag historisch zwischen ~0,8 und ~1,6
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(v) && v > 0.5 && v < 2) out.set(date, v);
  }
  return out;
}

// Kalendertag nach deutscher Zeit (wie das Steuerjahr im Export)
const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (d: Date) => berlinDay.format(d);

/** Kurs des Tages oder des letzten Handelstags davor (≤ 7 Tage); sonst null. */
export function ecbRateOn(rates: Map<string, number>, ts: Date): number | null {
  for (let back = 0; back <= 7; back++) {
    const r = rates.get(day(new Date(ts.getTime() - back * 86_400_000)));
    if (r !== undefined) return r;
  }
  return null;
}

/** Referenzkurse für den Zeitraum [from − 7 Tage, to]. */
export async function fetchEcbUsdPerEur(from: Date, to: Date, fetchFn: Fetch = fetch): Promise<Map<string, number>> {
  const qs = new URLSearchParams({ startPeriod: day(new Date(from.getTime() - 7 * 86_400_000)), endPeriod: day(to), format: 'csvdata' });
  const res = await fetchFn(`${ECB_EXR_URL}?${qs}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`EZB-Kurse: HTTP ${res.status}`);
  const rates = parseEcbCsv(await res.text());
  if (rates.size === 0) throw new Error('EZB-Kurse: keine Werte im Zeitraum.');
  return rates;
}
