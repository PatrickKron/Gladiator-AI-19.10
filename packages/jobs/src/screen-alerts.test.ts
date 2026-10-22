/**
 * Screen-Alarme: reine Logik (neue Treffer, Text) und gegen die ECHTE DB
 * (Server-CI; lokal ohne DATABASE_URL übersprungen): erster Lauf meldet die
 * aktuellen Treffer, Wiederholung schweigt, Rausfallen + Wiederkommen ist wieder
 * neu, ungültige Bedingungen stoppen den Lauf nicht. Push/Telegram sind aus.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { formatScreenAlert, newMatches, runScreenAlerts } from './screen-alerts.js';

const { users, ohlcv, screens, notifications } = schema;

describe('newMatches / formatScreenAlert', () => {
  it('neu = jetzt passend, vorher nicht; sortiert, ohne Doppelte', () => {
    expect(newMatches([], ['ETH/USDT', 'BTC/USDT', 'BTC/USDT'])).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(newMatches(['BTC/USDT'], ['BTC/USDT', 'SOL/USDT'])).toEqual(['SOL/USDT']);
    expect(newMatches(['BTC/USDT'], ['BTC/USDT'])).toEqual([]);
    expect(newMatches(['BTC/USDT'], [])).toEqual([]);
  });

  it('Text nennt Screen, Zeitrahmen und Symbole; lange Listen werden gekürzt, HTML maskiert', () => {
    const one = formatScreenAlert('RSI < 30', '1h', ['BTC/USDT']);
    expect(one.title).toBe('Screen „RSI < 30“: neuer Treffer');
    expect(one.html).toContain('RSI &lt; 30');
    expect(one.html).toContain('BTC/USDT');
    const many = formatScreenAlert('Breit', '4h', Array.from({ length: 15 }, (_, i) => `S${i}/USDT`));
    expect(many.title).toBe('Screen „Breit“: 15 neue Treffer');
    expect(many.html).toContain('+3');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('runScreenAlerts (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let risingId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const SYMBOL = `SCA${process.pid}/USDT`;
  // Eigene Kerzenquelle je Lauf: das Universum eines Screens ist venue × Zeitrahmen — mit 'binance' würden
  // parallel laufende Test-Dateien (eigene 1h-Kerzen) als „neue Treffer“ hineinspielen (CI-Flake).
  const VENUE = `sca-${process.pid}`;
  const T0 = 1_760_000_000;
  const H = 3600;
  const quiet = { notify: { pushConfigured: false, sendTelegram: async () => false } };
  const rising = [{ kind: 'compare', left: { kind: 'price' }, op: '>', right: { kind: 'number', value: 0 } }];
  const impossible = [{ kind: 'compare', left: { kind: 'price' }, op: '<', right: { kind: 'number', value: 0 } }];

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `screen-alert-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const rows = [];
    for (let i = 0; i < 300; i++) {
      const open = 100 + i * 0.1;
      rows.push({ venue: VENUE, symbol: SYMBOL, timeframe: '1h', ts: new Date((T0 + i * H) * 1000), open: String(open), high: String(open + 0.3), low: String(open - 0.2), close: String(open + 0.1), volume: '1000' });
    }
    await db.insert(ohlcv).values(rows).onConflictDoNothing();
    const [r] = await db.insert(screens).values({ userId, name: 'Steigt', timeframe: '1h', venue: VENUE, alert: true, conditions: rising }).returning();
    risingId = r!.id;
    await db.insert(screens).values([
      { userId, name: 'Unmöglich', timeframe: '1h', venue: VENUE, alert: true, conditions: impossible },
      { userId, name: 'Ohne Alarm', timeframe: '1h', venue: VENUE, alert: false, conditions: rising },
    ]);
  });

  afterAll(async () => {
    await db.delete(ohlcv).where(and(eq(ohlcv.symbol, SYMBOL), eq(ohlcv.venue, VENUE)));
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`); // Screens + Benachrichtigungen cascaden
    await pool.end();
  });

  const mine = () => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, 'screen')));

  it('erster Lauf meldet die aktuellen Treffer, der zweite schweigt; ohne Alarm läuft nichts', async () => {
    const r1 = await runScreenAlerts(db, quiet);
    expect(r1.screens).toBe(2);
    expect(r1.notified).toBe(1);
    expect(r1.errors).toEqual([]);
    const n = await mine();
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toContain('Steigt');
    expect(n[0]!.body).toContain(SYMBOL);
    expect(n[0]!.link).toBe(`#/screener?screen=${risingId}`);
    const [row] = await db.select().from(screens).where(eq(screens.id, risingId));
    expect(row!.lastMatches).toContain(SYMBOL);
    expect(row!.lastRunAt).not.toBeNull();
    expect(row!.lastAlertAt).not.toBeNull();
    const [imp] = await db.select().from(screens).where(and(eq(screens.userId, userId), eq(screens.name, 'Unmöglich')));
    expect(imp!.lastMatches).toEqual([]);
    expect(imp!.lastAlertAt).toBeNull();
    const [off] = await db.select().from(screens).where(and(eq(screens.userId, userId), eq(screens.name, 'Ohne Alarm')));
    expect(off!.lastRunAt).toBeNull();

    const r2 = await runScreenAlerts(db, quiet);
    expect(r2.notified).toBe(0);
    expect(await mine()).toHaveLength(1);
  });

  it('fällt ein Symbol raus und kommt wieder, ist es wieder neu', async () => {
    await db.update(screens).set({ conditions: impossible }).where(eq(screens.id, risingId));
    const out = await runScreenAlerts(db, quiet);
    expect(out.notified).toBe(0);
    expect((await db.select().from(screens).where(eq(screens.id, risingId)))[0]!.lastMatches).toEqual([]);
    await db.update(screens).set({ conditions: rising }).where(eq(screens.id, risingId));
    const back = await runScreenAlerts(db, quiet);
    expect(back.notified).toBe(1);
    expect(await mine()).toHaveLength(2);
  });

  it('ungültige Bedingungen → Fehler für diesen Screen, die anderen laufen weiter', async () => {
    await db.insert(screens).values({ userId, name: 'Kaputt', timeframe: '1h', venue: VENUE, alert: true, conditions: [{ kind: 'nix' }] });
    const r = await runScreenAlerts(db, quiet);
    expect(r.screens).toBe(3);
    expect(r.errors.some((e) => e.startsWith('Kaputt:'))).toBe(true);
    expect(r.notified).toBe(0);
  });
});
