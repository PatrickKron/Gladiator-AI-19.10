/**
 * Fehlerformat-Härtung: In Produktion dürfen tRPC-Fehlerantworten keine
 * Server-Interna preisgeben (Stack-Traces mit /opt/…-Pfaden, rohe interne
 * Fehlermeldungen). Dev/Test behalten volle Traces für die Fehlersuche.
 * Fail-safe: unbekanntes/fehlendes NODE_ENV wird wie Produktion behandelt.
 */
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@gladiator/db';
import { createApp } from './app.js';
import { sanitizeErrorShape } from './trpc.js';

const shapeFor = (code: string, message: string) => ({
  message,
  code: -32603,
  data: {
    code,
    httpStatus: 500,
    stack: 'Error: kaputt\n    at /opt/gladiator-v2/app/packages/api/src/routers/rl.ts:42:11',
    path: 'rl.runEpisode',
  },
});

describe('sanitizeErrorShape', () => {
  it('produktion: entfernt den Stack, behält code/httpStatus/path (Frontend braucht data.code)', () => {
    const out = sanitizeErrorShape(shapeFor('UNAUTHORIZED', 'Anmeldung erforderlich.'), 'production');
    expect(out.data).not.toHaveProperty('stack');
    expect(out.data.code).toBe('UNAUTHORIZED');
    expect(out.data.httpStatus).toBe(500);
    expect(out.data.path).toBe('rl.runEpisode');
    expect(out.message).toBe('Anmeldung erforderlich.');
  });

  it('produktion: maskiert die Message NUR bei INTERNAL_SERVER_ERROR (rohe interne Fehler können Pfade enthalten)', () => {
    const internal = sanitizeErrorShape(shapeFor('INTERNAL_SERVER_ERROR', 'ENOENT /opt/gladiator-v2/app/geheim.txt'), 'production');
    expect(internal.message).not.toContain('/opt/');
    expect(internal.message.length).toBeGreaterThan(0);

    // Bewusst geworfene Fehler (412/400/…) behalten ihre ehrliche Klartext-Message
    const honest = sanitizeErrorShape(shapeFor('PRECONDITION_FAILED', 'ANTHROPIC_API_KEY fehlt — Profil → API-Keys.'), 'production');
    expect(honest.message).toBe('ANTHROPIC_API_KEY fehlt — Profil → API-Keys.');
  });

  it('fehlendes NODE_ENV wird fail-safe wie Produktion behandelt', () => {
    const out = sanitizeErrorShape(shapeFor('INTERNAL_SERVER_ERROR', 'roh'), undefined);
    expect(out.data).not.toHaveProperty('stack');
    expect(out.message).not.toBe('roh');
  });

  it('development/test behalten Stack und Original-Message', () => {
    for (const env of ['development', 'test'] as const) {
      const out = sanitizeErrorShape(shapeFor('INTERNAL_SERVER_ERROR', 'roh'), env);
      expect(out.data.stack).toContain('/opt/gladiator-v2');
      expect(out.message).toBe('roh');
    }
  });
});

describe('HTTP-Fehlerantwort (Express-Adapter, ohne DB)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('produktion: 401 auf geschützte Prozedur enthält keinen Stack und keine Server-Pfade', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    // Fake-Db reicht: der Request scheitert an der Auth, bevor die DB angefasst wird.
    const app = createApp({ execute: async () => [] } as unknown as Db, { webDistDir: null });
    const res = await request(app).get('/api/trpc/rl.agents');
    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(res.body.error.data.code).toBe('UNAUTHORIZED');
    expect(body).not.toContain('stack');
    expect(body).not.toContain('/opt/');
    expect(body).not.toMatch(/[A-Za-z]:\\\\/);
  });
});
