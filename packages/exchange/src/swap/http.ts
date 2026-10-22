/**
 * HTTP-Hilfe für Aggregator-Aufrufe (Jupiter, KyberSwap). Öffentliche Aggregatoren drosseln
 * (HTTP 429) und haben kurze Störungen (502/503/504) — beides sagt nichts über unseren Code
 * und ist kein Grund, dem Nutzer „keine Route“ zu melden (Server-CI 2026-10-22: KyberSwap
 * 429 auf /routes und /route/build, weil zwei Testdateien gleichzeitig anfragten).
 * Lesende bzw. idempotente Aufrufe (Angebot holen, Transaktion BAUEN) werden deshalb bis zu
 * `tries`-mal wiederholt: Pause laut `Retry-After` (gedeckelt), sonst 1 s · 2^n.
 * NIE für das Senden einer Transaktion verwenden — ein wiederholtes Senden könnte doppelt kaufen.
 */
export type Fetch = typeof fetch;

/** Status, bei denen ein erneuter Versuch sinnvoll ist (Drosselung, kurze Störung des Dienstes). */
export const RETRY_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);
export const DEFAULT_TRIES = 4;
const MAX_RETRY_AFTER_MS = 10_000;

export type FetchJsonOpts = {
  /** Anläufe insgesamt (1 = kein Wiederholen). */
  tries?: number;
  timeoutMs?: number;
  /** Nur für Tests austauschbar. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pause vor Anlauf `attempt + 1`: `Retry-After` in Sekunden (gedeckelt), sonst 1 s, 2 s, 4 s, … */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const header = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, MAX_RETRY_AFTER_MS);
  return 1000 * 2 ** attempt;
}

export async function fetchJson(url: string, fetchFn: Fetch, init: RequestInit = {}, opts: FetchJsonOpts = {}): Promise<unknown> {
  const tries = Math.max(1, opts.tries ?? DEFAULT_TRIES);
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as unknown;
    if (!RETRY_STATUS.has(res.status) || attempt >= tries - 1) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    await sleep(retryDelayMs(attempt, res.headers.get('retry-after')));
  }
}
