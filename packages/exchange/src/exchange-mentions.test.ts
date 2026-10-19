import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { detectExchangeMentions, loadPreferredExchanges, rankPreferredExchanges } from './exchange-mentions.js';
import { listSupportedExchanges } from './connections.js';

/** Börsen-Erkennung aus Chat-Text (deterministisch, ohne LLM). */
describe('detectExchangeMentions', () => {
  const all = listSupportedExchanges();
  const ids = (text: string) => detectExchangeMentions(text, all).map((m) => m.id);

  it('erkennt gängige Börsen über Namen und Aliase', () => {
    expect(ids('Ich trade hauptsächlich auf Bybit und manchmal Binance')).toEqual(['bybit', 'binance']);
    expect(ids('Meine Perps laufen auf Hyperliquid, Spot bei Kraken')).toEqual(['hyperliquid', 'kraken']);
    expect(ids('Konto bei gate.io und crypto.com')).toEqual(['gate', 'cryptocom']);
    expect(ids('früher Huobi, jetzt OKX')).toEqual(['htx', 'okx']);
  });

  it('längster Treffer gewinnt (Binance US ≠ Binance, Kraken Futures ≠ Kraken)', () => {
    expect(ids('ich nutze Binance US')).toEqual(['binanceus']);
    expect(ids('Kraken Futures für Hebel')).toEqual(['krakenfutures']);
  });

  it('keine Fehltreffer bei Alltagswörtern (Risk-Gate, bullish, delta, extended …)', () => {
    expect(ids('Das Risk-Gate ist bullish, Delta neutral, Ziel extended, Gemini-Modell, Stop lighter setzen')).toEqual([]);
    expect(ids('BTC/USDT long auf dem 4h-Chart')).toEqual([]);
  });

  it('Groß/Klein egal, Mehrfachnennung nur einmal (Reihenfolge = erste Nennung)', () => {
    expect(ids('BYBIT bybit Bybit binance')).toEqual(['bybit', 'binance']);
  });
});

describe('rankPreferredExchanges', () => {
  it('zählt Nennungen über Nachrichten, sortiert nach Häufigkeit dann Aktualität', () => {
    const all = listSupportedExchanges();
    const ranked = rankPreferredExchanges(
      [
        { text: 'Kraken ist meine Hausbank', at: new Date('2026-10-01') },
        { text: 'Bybit für Perps', at: new Date('2026-10-02') },
        { text: 'nochmal Bybit, und Kraken', at: new Date('2026-10-03') },
        { text: 'Bybit Funding checken', at: new Date('2026-10-04') },
      ],
      all,
    );
    expect(ranked.map((r) => [r.id, r.mentions])).toEqual([
      ['bybit', 3],
      ['kraken', 2],
    ]);
    expect(ranked[0]!.lastMentionedAt.toISOString().slice(0, 10)).toBe('2026-10-04');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('loadPreferredExchanges (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `pref-${crypto.randomUUID()}@test.local` }).returning();
    userId = u!.id;
    const [s] = await db.insert(schema.workshopSessions).values({ userId, name: 'Pref', instructions: 'Nur Hyperliquid-Perps' }).returning();
    await db.insert(schema.workshopMessages).values([
      { sessionId: s!.id, role: 'user', content: 'Ich handle auf Bybit' },
      { sessionId: s!.id, role: 'assistant', content: 'Binance wäre auch möglich' }, // Coach-Text zählt NICHT
    ]);
    await db.insert(schema.exchangeConnections).values({
      userId, exchangeId: 'bybit', exchangeName: 'Bybit', encryptedPayload: 'x', keyLast4: 'abcd', mode: 'read_only', status: 'active',
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('nur eigene Nachrichten + Anweisungen; connected/walletLogin korrekt', async () => {
    const prefs = await loadPreferredExchanges(db, userId);
    expect(prefs.map((p) => p.id).sort()).toEqual(['bybit', 'hyperliquid']);
    expect(prefs.find((p) => p.id === 'bybit')).toMatchObject({ connected: true, walletLogin: false });
    expect(prefs.find((p) => p.id === 'hyperliquid')).toMatchObject({ connected: false, walletLogin: true });
  });
});
