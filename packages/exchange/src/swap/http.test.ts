/**
 * Aggregator-HTTP: Drosselung (429) und kurze Störungen (5xx) werden mit Pause wiederholt,
 * echte Fehler (4xx) sofort gemeldet; nennt der Dienst ein Fenster jenseits unserer Wartegrenze,
 * scheitert der Aufruf sofort und ehrlich mit dem Fenster im Fehler (kein hängendes Ticket).
 */
import { describe, expect, it } from 'vitest';
import { announcedWaitMs, backoffMs, DEFAULT_TRIES, fetchJson, HttpStatusError, MAX_WAIT_MS } from './http.js';

function sequence(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!; // letzte Antwort wiederholt sich
    return new Response(JSON.stringify(r.body ?? { code: r.status }), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const pauses: number[] = [];
  const sleep = async (ms: number) => {
    pauses.push(ms);
  };
  return { fetchFn, calls, pauses, sleep };
}

describe('Fenster und Backoff', () => {
  it('ohne Angabe: 1 s, 2 s, 4 s', () => {
    expect([0, 1, 2].map(backoffMs)).toEqual([1000, 2000, 4000]);
  });
  it('Retry-After vor X-RateLimit-Reset-After, Sekunden → ms; Datum/Unsinn → null', () => {
    expect(announcedWaitMs(new Headers({ 'retry-after': '3', 'x-ratelimit-reset-after': '180' }))).toBe(3000);
    expect(announcedWaitMs(new Headers({ 'x-ratelimit-reset-after': '180' }))).toBe(180_000);
    expect(announcedWaitMs(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeNull();
    expect(announcedWaitMs(new Headers())).toBeNull();
  });
});

describe('fetchJson', () => {
  it('429 → Pause → Erfolg; Antwort ist das geparste JSON', async () => {
    const s = sequence([{ status: 429 }, { status: 200, body: { ok: true } }]);
    await expect(fetchJson('https://x.test/a', s.fetchFn, {}, { sleep: s.sleep })).resolves.toEqual({ ok: true });
    expect(s.calls).toHaveLength(2);
    expect(s.pauses).toEqual([1000]);
  });

  it('hält sich an ein kurzes, vom Dienst genanntes Fenster', async () => {
    const s = sequence([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: 1 }]);
    await fetchJson('https://x.test/a', s.fetchFn, {}, { sleep: s.sleep });
    expect(s.pauses).toEqual([2000]);
  });

  it('Fenster jenseits der Wartegrenze (KyberSwap: 180 s je Anfrage) → sofort ehrlich scheitern, Fenster im Fehler', async () => {
    const s = sequence([{ status: 429, body: { message: 'Forbidden' }, headers: { 'x-ratelimit-reset-after': '180' } }]);
    const err = await fetchJson('https://x.test/a', s.fetchFn, {}, { sleep: s.sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err as HttpStatusError).toMatchObject({ status: 429, retryAfterMs: 180_000 });
    expect((err as Error).message).toMatch(/^HTTP 429: .*Forbidden.*frei in 180 s/);
    expect(s.calls).toHaveLength(1);
    expect(s.pauses).toEqual([]);
    expect(180_000).toBeGreaterThan(MAX_WAIT_MS);
  });

  it('503 wird wiederholt, 400 sofort gemeldet', async () => {
    const ok = sequence([{ status: 503 }, { status: 200, body: 'ja' }]);
    await expect(fetchJson('https://x.test/a', ok.fetchFn, {}, { sleep: ok.sleep })).resolves.toBe('ja');
    const bad = sequence([{ status: 400, body: { message: 'kaputt' } }]);
    await expect(fetchJson('https://x.test/a', bad.fetchFn, {}, { sleep: bad.sleep })).rejects.toThrow(/^HTTP 400: .*kaputt/);
    expect(bad.calls).toHaveLength(1);
    expect(bad.pauses).toEqual([]);
  });

  it('nach dem letzten Anlauf kommt der Drossel-Status ehrlich hoch (Standard: 4 Anläufe)', async () => {
    const s = sequence([{ status: 429 }]);
    await expect(fetchJson('https://x.test/a', s.fetchFn, {}, { sleep: s.sleep })).rejects.toThrow(/^HTTP 429/);
    expect(s.calls).toHaveLength(DEFAULT_TRIES);
    expect(s.pauses).toEqual([1000, 2000, 4000]);
  });

  it('tries: 1 = kein Wiederholen (für Aufrufe, die etwas senden)', async () => {
    const s = sequence([{ status: 429 }]);
    await expect(fetchJson('https://x.test/a', s.fetchFn, {}, { tries: 1, sleep: s.sleep })).rejects.toThrow(/^HTTP 429/);
    expect(s.calls).toHaveLength(1);
  });

  it('reicht Methode, Header und Body durch', async () => {
    const s = sequence([{ status: 200, body: {} }]);
    await fetchJson('https://x.test/a', s.fetchFn, { method: 'POST', headers: { 'x-client-id': 'gladiator' }, body: '{"a":1}' }, { sleep: s.sleep });
    expect(s.calls[0]).toMatchObject({ method: 'POST', headers: { 'x-client-id': 'gladiator' }, body: '{"a":1}' });
  });
});
