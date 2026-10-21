/**
 * On-Chain-Daten für das DNA-Quadrant (Blueprint 09_ „Gravity/Pulse/Footprint/
 * DNA“): ersetzt das frühere `Math.random()`-MVRV der v1 durch echte, freie
 * Quellen ohne Schlüssel:
 *   - Coin Metrics Community-API: MVRV (CapMVRVCur) und aktive Adressen
 *     (AdrActCnt) für BTC und ETH, täglich.
 *   - DefiLlama: Gesamtumlauf der USD-Stablecoins (täglich) — „trockenes
 *     Pulver“ im Markt.
 * Eingeordnet wird wie beim Buffett-Indikator über das EIGENE historische
 * Perzentil (selbstkalibrierend); MVRV < 1 = klassische Unterbewertung.
 * Fehlt eine Quelle, ist ihr Teil `null` mit Grund — nie geschätzt.
 */

export const COINMETRICS_API = 'https://community-api.coinmetrics.io/v4';
export const DEFILLAMA_STABLECOINS_API = 'https://stablecoins.llama.fi';

type Fetch = typeof fetch;

export type DailyPoint = { ts: number; value: number };

export type MvrvZone = 'undervalued' | 'neutral' | 'elevated' | 'overheated';

export type OnchainAsset = {
  asset: 'btc' | 'eth';
  mvrv: number | null;
  /** Perzentil des aktuellen MVRV in der eigenen Geschichte (0..1) */
  mvrvPercentile: number | null;
  zone: MvrvZone | null;
  activeAddresses: number | null;
  /** Ø aktive Adressen der letzten 30 Tage gegenüber den 30 Tagen davor, in % */
  activeAddresses30dPct: number | null;
  asOf: string | null;
  error: string | null;
};

export type StablecoinSupply = { totalUsd: number | null; change30dPct: number | null; asOf: string | null; error: string | null };

export type OnchainSnapshot = { assets: OnchainAsset[]; stablecoins: StablecoinSupply };

function percentileRank(value: number, arr: number[]): number {
  if (arr.length <= 1) return 0.5;
  return arr.filter((v) => v < value).length / (arr.length - 1);
}

/**
 * MVRV-Zone: < 1 unterbewertet (Marktwert unter realisiertem Wert); sonst
 * über das eigene Perzentil: ≥ 95 % überhitzt, ≥ 80 % erhöht. Unter 60
 * Tagen Geschichte keine Zone (nie geraten).
 */
export function mvrvZone(current: number, history: number[]): { zone: MvrvZone | null; percentile: number | null } {
  if (!Number.isFinite(current)) return { zone: null, percentile: null };
  if (history.length < 60) return { zone: current < 1 ? 'undervalued' : null, percentile: null };
  const p = percentileRank(current, history);
  const zone: MvrvZone = current < 1 ? 'undervalued' : p >= 0.95 ? 'overheated' : p >= 0.8 ? 'elevated' : 'neutral';
  return { zone, percentile: p };
}

/** Ø der letzten `days` Punkte gegenüber den `days` davor, in %; zu wenig Daten → null. */
export function windowChangePct(points: DailyPoint[], days = 30): number | null {
  if (points.length < days * 2) return null;
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const avg = (xs: DailyPoint[]) => xs.reduce((s, p) => s + p.value, 0) / xs.length;
  const recent = avg(sorted.slice(-days));
  const before = avg(sorted.slice(-2 * days, -days));
  return before > 0 ? ((recent - before) / before) * 100 : null;
}

/** Wert heute gegenüber vor `days` Tagen in % (für Bestandsgrößen wie den Stablecoin-Umlauf). */
export function pointChangePct(points: DailyPoint[], days = 30): number | null {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const last = sorted.at(-1);
  if (!last) return null;
  const target = last.ts - days * 86_400_000;
  // jüngster Punkt am oder vor dem Zieltag
  const past = [...sorted].reverse().find((p) => p.ts <= target);
  return past && past.value > 0 ? ((last.value - past.value) / past.value) * 100 : null;
}

type CmRow = { asset?: string; time?: string; CapMVRVCur?: string; AdrActCnt?: string };

/** Coin-Metrics-Antwort → Reihen je Asset (rein, getestet). Leere/kaputte Werte fallen raus. */
export function parseCoinMetrics(body: unknown): Map<string, { mvrv: DailyPoint[]; active: DailyPoint[] }> {
  const out = new Map<string, { mvrv: DailyPoint[]; active: DailyPoint[] }>();
  const rows = ((body as { data?: CmRow[] } | null)?.data ?? []) as CmRow[];
  for (const r of rows) {
    const ts = r.time ? Date.parse(r.time) : Number.NaN;
    if (!r.asset || !Number.isFinite(ts)) continue;
    const e = out.get(r.asset) ?? { mvrv: [], active: [] };
    const m = Number(r.CapMVRVCur);
    const a = Number(r.AdrActCnt);
    if (r.CapMVRVCur !== undefined && r.CapMVRVCur !== '' && Number.isFinite(m) && m > 0) e.mvrv.push({ ts, value: m });
    if (r.AdrActCnt !== undefined && r.AdrActCnt !== '' && Number.isFinite(a) && a >= 0) e.active.push({ ts, value: a });
    out.set(r.asset, e);
  }
  return out;
}

/** DefiLlama `stablecoincharts/all` → Gesamtumlauf USD-Stablecoins je Tag (rein, getestet). */
export function parseStablecoinChart(body: unknown): DailyPoint[] {
  if (!Array.isArray(body)) return [];
  const out: DailyPoint[] = [];
  for (const row of body as { date?: string | number; totalCirculatingUSD?: { peggedUSD?: number } }[]) {
    const ts = Number(row.date) * 1000;
    const v = row.totalCirculatingUSD?.peggedUSD;
    if (Number.isFinite(ts) && typeof v === 'number' && Number.isFinite(v) && v > 0) out.push({ ts, value: v });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function summarizeAsset(asset: 'btc' | 'eth', series: { mvrv: DailyPoint[]; active: DailyPoint[] } | undefined): OnchainAsset {
  if (!series || (series.mvrv.length === 0 && series.active.length === 0)) {
    return { asset, mvrv: null, mvrvPercentile: null, zone: null, activeAddresses: null, activeAddresses30dPct: null, asOf: null, error: 'keine Daten' };
  }
  const mvrv = [...series.mvrv].sort((a, b) => a.ts - b.ts);
  const active = [...series.active].sort((a, b) => a.ts - b.ts);
  const last = mvrv.at(-1);
  const z = last ? mvrvZone(last.value, mvrv.map((p) => p.value)) : { zone: null, percentile: null };
  const lastTs = Math.max(last?.ts ?? 0, active.at(-1)?.ts ?? 0);
  return {
    asset,
    mvrv: last?.value ?? null,
    mvrvPercentile: z.percentile,
    zone: z.zone,
    activeAddresses: active.at(-1)?.value ?? null,
    activeAddresses30dPct: windowChangePct(active, 30),
    asOf: lastTs > 0 ? new Date(lastTs).toISOString() : null,
    error: null,
  };
}

async function getJson(url: string, fetchFn: Fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Echte Abfrage beider Quellen; eine fehlende Quelle macht nur ihren Teil null. */
export async function fetchOnchainSnapshot(fetchFn: Fetch = fetch, now = Date.now()): Promise<OnchainSnapshot> {
  const start = new Date(now - 4 * 365 * 86_400_000).toISOString().slice(0, 10);
  const cmUrl = `${COINMETRICS_API}/timeseries/asset-metrics?assets=btc,eth&metrics=CapMVRVCur,AdrActCnt&frequency=1d&start_time=${start}&page_size=10000`;
  const [cm, sc] = await Promise.allSettled([getJson(cmUrl, fetchFn), getJson(`${DEFILLAMA_STABLECOINS_API}/stablecoincharts/all`, fetchFn)]);

  const why = (r: PromiseRejectedResult) => (r.reason instanceof Error ? r.reason.message : String(r.reason));
  let assets: OnchainAsset[];
  if (cm.status === 'fulfilled') {
    const series = parseCoinMetrics(cm.value);
    assets = (['btc', 'eth'] as const).map((a) => summarizeAsset(a, series.get(a)));
  } else {
    const error = `Coin Metrics nicht erreichbar (${why(cm)})`;
    assets = (['btc', 'eth'] as const).map((asset) => ({ asset, mvrv: null, mvrvPercentile: null, zone: null, activeAddresses: null, activeAddresses30dPct: null, asOf: null, error }));
  }

  let stablecoins: StablecoinSupply;
  if (sc.status === 'fulfilled') {
    const points = parseStablecoinChart(sc.value);
    const last = points.at(-1);
    stablecoins = last
      ? { totalUsd: last.value, change30dPct: pointChangePct(points, 30), asOf: new Date(last.ts).toISOString(), error: null }
      : { totalUsd: null, change30dPct: null, asOf: null, error: 'keine Daten' };
  } else {
    stablecoins = { totalUsd: null, change30dPct: null, asOf: null, error: `DefiLlama nicht erreichbar (${why(sc)})` };
  }
  return { assets, stablecoins };
}
