/**
 * FRED-Public-CSV (fredgraph.csv) — offizielle Fed-Daten OHNE API-Key.
 * Primärquelle für die GRS-Serien (Yahoo blockt Rechenzentrums-IPs mit 429):
 *   VIX   → VIXCLS   (CBOE Volatility Index, Tagesschluss)
 *   DXY   → DTWEXBGS (Fed Broad Dollar Index — echter Dollar-Index der Fed;
 *                     für die 20-Tage-Änderung äquivalent zum ICE-DXY, ehrlich dokumentiert)
 *   US10Y → DGS10    (10-Year Treasury Constant Maturity, in %)
 * Fehlende Werte stehen im CSV als '.' und werden verworfen — nie interpoliert.
 */

export const FRED_PUBLIC_SERIES: Record<'VIX' | 'DXY' | 'US10Y', string> = {
  VIX: 'VIXCLS',
  DXY: 'DTWEXBGS',
  US10Y: 'DGS10',
};

export type FredCsvPoint = { ts: Date; value: number };

/** Parst fredgraph.csv ("DATE,SERIE\n2026-01-02,17.22\n2026-01-03,.\n…"). */
export function parseFredCsv(csv: string): FredCsvPoint[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const out: FredCsvPoint[] = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!date || raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue; // '.' = fehlender Wert → verwerfen
    const ts = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(ts.getTime())) continue;
    out.push({ ts, value });
  }
  return out;
}

export async function fetchFredPublicSeries(fredId: string, fromIso: string): Promise<FredCsvPoint[]> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(fredId)}&cosd=${fromIso}`;
  const res = await fetch(url, { headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`FRED-public ${fredId}: HTTP ${res.status}`);
  return parseFredCsv(await res.text());
}
