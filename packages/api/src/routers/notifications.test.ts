/**
 * Benachrichtigungen gegen die ECHTE DB: Glocke (Liste/Ungelesen/Abhaken),
 * Nutzer-Scoping, Push-Abo je Gerät (Upsert, Abmelden). Push-Versand selbst
 * testet notify.test.ts (injiziert) — hier ohne VAPID ehrlich „nicht eingerichtet“.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import { notify } from '@gladiator/jobs';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL_A = `notif-a-${RUN}@test.invalid`;
const EMAIL_B = `notif-b-${RUN}@test.invalid`;

describe.skipIf(!hasDb)('Benachrichtigungen: Glocke, Scoping, Push-Abo', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;
  let b: ReturnType<typeof createCaller>;
  let userAId: string;
  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;

  beforeAll(async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    ({ db, pool } = createDb());
    const ra = await register(db, { email: EMAIL_A, password: 'sehr-sicheres-passwort-123', name: 'A' });
    const rb = await register(db, { email: EMAIL_B, password: 'sehr-sicheres-passwort-123', name: 'B' });
    userAId = ra.user.id;
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${ra.accessToken}` }));
    b = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${rb.accessToken}` }));
  });

  afterAll(async () => {
    if (savedPub !== undefined) process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv !== undefined) process.env.VAPID_PRIVATE_KEY = savedPriv;
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email IN (${EMAIL_A}, ${EMAIL_B}))`);
    await db.execute(sql`DELETE FROM users WHERE email IN (${EMAIL_A}, ${EMAIL_B})`);
    await pool.end();
  });

  // Andere Testdateien laufen parallel gegen dieselbe DB und senden System-Benachrichtigungen
  // an ALLE User (Signal-Review, Briefing) — deshalb prüfen die Tests ihre eigenen Einträge
  // (per Id/Titel) statt absoluter Zählerstände.
  const own = (list: { title: string }[], title: string) => list.filter((n) => n.title === title);

  it('neue Benachrichtigung erscheint nur beim Empfänger, Ungelesen-Zähler zählt sie', async () => {
    const title = `Preis-Alarm BTC ${RUN}`;
    const before = (await a.notifications.unreadCount()).unread;
    await notify(db, { userId: userAId, kind: 'price_alert', title, body: 'Kurs ≥ 70.000', link: '#/charts' });
    expect((await a.notifications.unreadCount()).unread).toBeGreaterThanOrEqual(before + 1);
    expect(own(await a.notifications.list(), title)[0]).toMatchObject({ kind: 'price_alert', read: false, link: '#/charts' });
    expect(own(await b.notifications.list(), title)).toHaveLength(0);
  });

  it('abhaken: fremde Ids wirken nicht, eigene schon; „alle gelesen" leert den Zähler', async () => {
    const title = `Preis-Alarm BTC ${RUN}`;
    const [n] = own(await a.notifications.list(), title);
    await b.notifications.markRead({ ids: [n!.id] });
    expect(own(await a.notifications.list({ unreadOnly: true }), title)).toHaveLength(1);
    await a.notifications.markRead({ ids: [n!.id] });
    expect(own(await a.notifications.list({ unreadOnly: true }), title)).toHaveLength(0);
    const second = `Zweite ${RUN}`;
    await notify(db, { userId: userAId, kind: 'system', title: second, body: 'y' });
    await a.notifications.markAllRead();
    const unread = await a.notifications.list({ unreadOnly: true });
    expect(own(unread, second)).toHaveLength(0);
  });

  it('Push ohne VAPID ehrlich „nicht eingerichtet"; Abo je Gerät (Upsert), Abmelden widerruft', async () => {
    expect(await a.notifications.pushStatus()).toMatchObject({ configured: false, publicKey: null, devices: 0 });
    const endpoint = `https://push.test/dev-${RUN}`;
    await a.notifications.subscribe({ endpoint, keys: { p256dh: 'k1', auth: 'a1' } });
    await a.notifications.subscribe({ endpoint, keys: { p256dh: 'k2', auth: 'a2' } });
    expect((await a.notifications.pushStatus()).devices).toBe(1);
    await a.notifications.unsubscribe({ endpoint });
    expect((await a.notifications.pushStatus()).devices).toBe(0);
  });

  it('Test-Benachrichtigung landet in der Glocke, Push-Zähler 0 ohne Einrichtung', async () => {
    await a.notifications.markAllRead();
    const r = await a.notifications.test();
    expect(r).toMatchObject({ created: 1, pushed: 0 });
    expect(own(await a.notifications.list({ unreadOnly: true }), 'Gladiator: Test-Benachrichtigung')).toHaveLength(1);
  });
});
