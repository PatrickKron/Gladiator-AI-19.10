/**
 * Benachrichtigungen (Vision-Punkt 3): notify() schreibt in die App-Glocke,
 * stellt per Web-Push zu (abgelaufene Abos werden widerrufen) und optional Telegram.
 * Push/Telegram sind injiziert — echte Netz-Calls gehören nicht in Tests.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { notify, pushPayload, type PushSender } from './notify.js';

const { users, notifications, pushSubscriptions } = schema;

describe('pushPayload', () => {
  it('kompaktes JSON mit Titel, Text, Link, Schwere und Id', () => {
    const p = JSON.parse(pushPayload({ id: 'n1', title: 'BTC Long', body: 'Score 8,1', link: '#/signals', severity: 'info' }));
    expect(p).toEqual({ id: 'n1', title: 'BTC Long', body: 'Score 8,1', link: '#/signals', severity: 'info' });
  });

  it('kürzt sehr lange Texte (Push-Dienste begrenzen die Größe)', () => {
    const p = JSON.parse(pushPayload({ id: 'n', title: 't', body: 'x'.repeat(5_000), link: null, severity: 'info' }));
    expect(p.body.length).toBeLessThanOrEqual(1_000);
    expect(p.body.endsWith('…')).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('notify (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const RUN = `${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `notify-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    await db.insert(pushSubscriptions).values([
      { userId, endpoint: `https://push.test/ok-${RUN}`, keys: { p256dh: 'k', auth: 'a' } },
      { userId, endpoint: `https://push.test/gone-${RUN}`, keys: { p256dh: 'k', auth: 'a' } },
      { userId, endpoint: `https://push.test/flaky-${RUN}`, keys: { p256dh: 'k', auth: 'a' } },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email = ${`notify-${RUN}@test.invalid`}`);
    await pool.end();
  });

  it('schreibt in die Glocke, pusht an alle Geräte, widerruft abgelaufene Abos, zählt Fehler', async () => {
    const sent: string[] = [];
    const sendPush: PushSender = async (sub) => {
      if (sub.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      if (sub.endpoint.includes('flaky')) throw Object.assign(new Error('Server'), { statusCode: 500 });
      sent.push(sub.endpoint);
    };
    let telegramText: string | null = null;
    const res = await notify(
      db,
      { userId, kind: 'signal', title: 'BTC/USDT Long', body: 'Score 8,1 · Entry 64.000', link: '#/signals', telegramHtml: '<b>BTC</b>' },
      { sendPush, sendTelegram: async (t) => ((telegramText = t), true), pushConfigured: true },
    );
    expect(res).toMatchObject({ created: 1, pushed: 1, pushFailed: 2, removed: 1, telegram: true });
    expect(telegramText).toBe('<b>BTC</b>');

    const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'signal', title: 'BTC/USDT Long', readAt: null });

    const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    expect(subs.find((s) => s.endpoint.includes('gone'))!.revokedAt).not.toBeNull();
    expect(subs.find((s) => s.endpoint.includes('flaky'))!.failureCount).toBe(1);
    expect(subs.find((s) => s.endpoint.includes('ok'))!.lastSuccessAt).not.toBeNull();
  });

  it('ohne Push-Schlüssel: Glocke funktioniert trotzdem, kein Push-Versuch', async () => {
    let calls = 0;
    const res = await notify(db, { userId, kind: 'system', title: 'Test', body: 'ohne Push' }, { sendPush: async () => void calls++, pushConfigured: false });
    expect(res).toMatchObject({ created: 1, pushed: 0 });
    expect(calls).toBe(0);
  });
});
