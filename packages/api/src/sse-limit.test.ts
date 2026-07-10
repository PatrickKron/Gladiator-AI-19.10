import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '@gladiator/db';
import { createApp } from './app.js';

/**
 * SSE-Limit je Client-IP (Socket-Hunger-Schutz): Chrome erlaubt nur 6
 * Verbindungen je Host — viele offene Tabs mit je einem Preis-Stream ließen
 * neue Tabs endlos im "Lädt …" hängen. Ab dem 4. Stream derselben IP
 * antwortet der Server mit 429; EventSource schließt bei Nicht-200 dauerhaft.
 * Die Route braucht keine DB — ein leerer Stub reicht (kein Mock-Datenpfad).
 */

const app = createApp({} as unknown as Db, {});
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

function openStream(): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path: '/api/stream/prices' }, resolve);
    req.on('error', reject);
  });
}

function closeStream(res: http.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    res.destroy();
    // Warten, bis der Server das close-Event verarbeitet hat (Zähler-Decrement).
    setTimeout(resolve, 50);
  });
}

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('SSE /api/stream/prices: Limit je IP', () => {
  it('3 Streams ok, der 4. bekommt 429; nach Schließen wird der Slot wieder frei', async () => {
    const s1 = await openStream();
    const s2 = await openStream();
    const s3 = await openStream();
    expect([s1.statusCode, s2.statusCode, s3.statusCode]).toEqual([200, 200, 200]);

    const s4 = await openStream();
    expect(s4.statusCode).toBe(429);
    await closeStream(s4);

    await closeStream(s1);
    const s5 = await openStream();
    expect(s5.statusCode).toBe(200);

    await closeStream(s2);
    await closeStream(s3);
    await closeStream(s5);
  });
});
