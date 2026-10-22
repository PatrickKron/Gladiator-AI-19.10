/**
 * HTTP-Hilfe für Aggregator-Aufrufe (Jupiter, KyberSwap). Öffentliche Aggregatoren drosseln
 * (HTTP 429) und haben kurze Störungen (502/503/504) — beides sagt nichts über unseren Code
 * und ist kein Grund, dem Nutzer „keine Route“ zu melden. Lesende bzw. idempotente Aufrufe
 * (Angebot holen, Transaktion BAUEN) werden deshalb bis zu `tries`-mal wiederholt.
 *
 * Nennt der Dienst das Fenster (`Retry-After` bzw. `X-RateLimit-Reset-After`, Sekunden), wird
 * genau so lange gewartet — aber nur bis `MAX_WAIT_MS`. Ein längeres Fenster (KyberSwap sperrt
 * Datacenter-Adressen z. B. auf 1 Anfrage je 180 s, Server-CI 2026-10-22) wird NICHT abgesessen:
 * dann kommt sofort ein `HttpStatusError` mit `retryAfterMs`, damit die Oberfläche ehrlich
 * „gedrosselt, frei in n s“ zeigen kann statt eine halbe Minute zu hängen. Ohne Angabe: 1 s · 2^n.
 * NIE für das Senden einer Transaktion verwenden — ein wiederholtes Senden könnte doppelt kaufen.
 */
export type Fetch = typeof fetch;

/** Status, bei denen ein erneuter Versuch sinnvoll ist (Drosselung, kurze Störung des Dienstes). */
export const RETRY_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);
export const DEFAULT_TRIES = 4;
/** Länger wartet ein Angebots-/Bau-Aufruf nie — der Nutzer sieht sonst nur ein hängendes Ticket. */
export const MAX_WAIT_MS = 10_000;

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    body: string,
    /** Vom Dienst genanntes Fenster bis zur nächsten erlaubten Anfrage (ms), sonst null. */
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}${retryAfterMs !== null ? ` (Drosselung: frei in ${Math.ceil(retryAfterMs / 1000)} s)` : ''}`);
    this.name = 'HttpStatusError';
  }
}

export type FetchJsonOpts = {
  /** Anläufe insgesamt (1 = kein Wiederholen). */
  tries?: number;
  timeoutMs?: number;
  /** Nur für Tests austauschbar. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Vom Dienst genanntes Fenster in ms (`Retry-After` in Sekunden hat Vorrang, sonst `X-RateLimit-Reset-After`), sonst null. */
export function announcedWaitMs(headers: Headers): number | null {
  for (const name of ['retry-after', 'x-ratelimit-reset-after']) {
    const v = headers.get(name);
    if (v === null) continue;
    const sec = Number(v);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  }
  return null;
}

/** Pause vor Anlauf `attempt + 1`, wenn der Dienst kein Fenster nennt: 1 s, 2 s, 4 s, … */
export function backoffMs(attempt: number): number {
  return 1000 * 2 ** attempt;
}

export async function fetchJson(url: string, fetchFn: Fetch, init: RequestInit = {}, opts: FetchJsonOpts = {}): Promise<unknown> {
  const tries = Math.max(1, opts.tries ?? DEFAULT_TRIES);
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as unknown;
    const wait = announcedWaitMs(res.headers);
    const lastTry = attempt >= tries - 1;
    // Fenster länger als wir je warten → sofort ehrlich scheitern (Aufrufer sieht retryAfterMs)
    if (!RETRY_STATUS.has(res.status) || lastTry || (wait !== null && wait > MAX_WAIT_MS)) throw new HttpStatusError(res.status, text, wait);
    await sleep(wait ?? backoffMs(attempt));
  }
}
