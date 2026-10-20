/**
 * Universelle Börsen-Anbindung (CCXT): pure Logik lokal, DB-Roundtrip nur mit
 * DATABASE_URL (Server-CI maßgeblich). ccxt-Client ist ein Test-Double —
 * echte Börsen-Calls gehören nicht in die CI.
 */
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type pg from 'pg';
import {
  connectExchange,
  connectWallet,
  fetchConnectionBalances,
  isValidEvmAddress,
  walletExchanges,
  isSupportedExchange,
  listConnections,
  listSupportedExchanges,
  normalizeSymbol,
  pickConnectionForSymbol,
  revokeConnection,
  setConnectionMode,
  summarizeMarkets,
  type CcxtLikeClient,
  type ConnectionForRouting,
} from './connections.js';

const savedKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

describe('listSupportedExchanges', () => {
  it('liefert 100+ Börsen inkl. Kraken/Bybit/OKX (Patricks „Börse des Vertrauens")', () => {
    const list = listSupportedExchanges();
    expect(list.length).toBeGreaterThan(100);
    const ids = list.map((e) => e.id);
    for (const wanted of ['kraken', 'bybit', 'okx', 'binance', 'coinbase']) {
      expect(ids).toContain(wanted);
    }
    // Anzeigename vorhanden und sortiert
    expect(list.every((e) => e.name.length > 0)).toBe(true);
  });

  it('isSupportedExchange kennt nur echte CCXT-IDs', () => {
    expect(isSupportedExchange('kraken')).toBe(true);
    expect(isSupportedExchange('nicht-existente-boerse')).toBe(false);
  });
});

describe('summarizeMarkets (automatische Asset-Erkennung)', () => {
  const markets = {
    'BTC/USDT': { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true },
    'ETH/EUR': { symbol: 'ETH/EUR', base: 'ETH', quote: 'EUR', active: true },
    'BTC/USDT:USDT': {
      symbol: 'BTC/USDT:USDT',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      contract: true,
      limits: { leverage: { max: 125 } },
    },
    'DEAD/USDT': { symbol: 'DEAD/USDT', base: 'DEAD', quote: 'USDT', active: false },
  };

  it('zählt nur aktive Märkte, erkennt Futures und Max-Hebel', () => {
    const s = summarizeMarkets(markets);
    expect(s.symbolCount).toBe(3);
    expect(s.symbols).toContain('BTC/USDT:USDT');
    expect(s.symbols).not.toContain('DEAD/USDT');
    expect(s.quoteCurrencies).toEqual(['EUR', 'USDT']);
    expect(s.baseAssets).toEqual(['BTC', 'ETH']);
    expect(s.hasFutures).toBe(true);
    expect(s.maxLeverage).toBe(125);
  });

  it('Spot-only-Börse: hasFutures false, maxLeverage null', () => {
    const s = summarizeMarkets({ 'BTC/EUR': { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', active: true } });
    expect(s.hasFutures).toBe(false);
    expect(s.maxLeverage).toBeNull();
  });
});

describe('Wallet-Anschluss (nur lesend, öffentliche Adresse)', () => {
  it('isValidEvmAddress akzeptiert nur 0x + 40 Hex-Zeichen', () => {
    expect(isValidEvmAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(isValidEvmAddress('0x' + 'A1'.repeat(20))).toBe(true);
    expect(isValidEvmAddress('0x' + 'a'.repeat(39))).toBe(false);
    expect(isValidEvmAddress('a'.repeat(42))).toBe(false);
    expect(isValidEvmAddress('0x' + 'g'.repeat(40))).toBe(false);
  });

  it('walletExchanges = CCXT-Börsen, die eine Wallet-Adresse statt API-Key nutzen (Hyperliquid)', () => {
    const ids = walletExchanges().map((e) => e.id);
    expect(ids).toContain('hyperliquid');
    expect(ids).not.toContain('kraken');
  });
});

describe('normalizeSymbol', () => {
  it('BTCUSDT → BTC/USDT, BTC/USDT bleibt, Groß/Klein egal', () => {
    expect(normalizeSymbol('BTCUSDT')).toBe('BTC/USDT');
    expect(normalizeSymbol('BTC/USDT')).toBe('BTC/USDT');
    expect(normalizeSymbol('ethusdc')).toBe('ETH/USDC');
    expect(normalizeSymbol('SOLEUR')).toBe('SOL/EUR');
  });
});

describe('pickConnectionForSymbol (Order-Router)', () => {
  const base = {
    mode: 'trading' as const,
    status: 'active' as const,
    marketsSummary: {
      symbolCount: 1,
      symbols: ['BTC/USDT'],
      quoteCurrencies: ['USDT'],
      baseAssets: ['BTC'],
      hasFutures: false,
      maxLeverage: null,
    },
  };

  it('wählt die Börse, auf der das Asset handelbar ist', () => {
    const conns: ConnectionForRouting[] = [
      { ...base, id: 'a', exchangeId: 'kraken', createdAt: new Date('2026-01-01'), marketsSummary: { ...base.marketsSummary, symbols: ['ETH/EUR'] } },
      { ...base, id: 'b', exchangeId: 'bybit', createdAt: new Date('2026-01-02') },
    ];
    expect(pickConnectionForSymbol(conns, 'BTC/USDT')?.id).toBe('b');
    expect(pickConnectionForSymbol(conns, 'ETH/EUR')?.id).toBe('a');
  });

  it('read_only-, error- und revoked-Verbindungen führen nie Orders', () => {
    const conns: ConnectionForRouting[] = [
      { ...base, id: 'a', exchangeId: 'kraken', createdAt: new Date('2026-01-01'), mode: 'read_only' },
      { ...base, id: 'b', exchangeId: 'bybit', createdAt: new Date('2026-01-02'), status: 'error' },
      { ...base, id: 'c', exchangeId: 'okx', createdAt: new Date('2026-01-03'), status: 'revoked' },
    ];
    expect(pickConnectionForSymbol(conns, 'BTC/USDT')).toBeNull();
  });

  it('bei mehreren Treffern gewinnt die älteste Verbindung; Perp-Variante zählt', () => {
    const conns: ConnectionForRouting[] = [
      { ...base, id: 'neu', exchangeId: 'bybit', createdAt: new Date('2026-02-01') },
      { ...base, id: 'alt', exchangeId: 'kraken', createdAt: new Date('2026-01-01') },
      {
        ...base,
        id: 'perp',
        exchangeId: 'okx',
        createdAt: new Date('2026-03-01'),
        marketsSummary: { ...base.marketsSummary, symbols: ['SOL/USDT:USDT'] },
      },
    ];
    expect(pickConnectionForSymbol(conns, 'BTC/USDT')?.id).toBe('alt');
    expect(pickConnectionForSymbol(conns, 'SOLUSDT')?.id).toBe('perp');
  });
});

// ---------- DB-Roundtrip (nur Server-CI mit DATABASE_URL) ----------

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[connections.test] DATABASE_URL fehlt — DB-Teil übersprungen (Server-CI maßgeblich).');

function fakeClient(overrides?: Partial<CcxtLikeClient> & { name?: string }): CcxtLikeClient {
  return {
    loadMarkets: async () => ({
      'BTC/USDT': { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true },
      'ETH/USDT': { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true },
    }),
    fetchBalance: async () => ({ total: { USDT: 1234.5, BTC: 0.5, DUST: 0 }, free: { USDT: 1000, BTC: 0.5 }, used: { USDT: 234.5 } }),
    ...overrides,
  };
}

describe.skipIf(!hasDb)('Börsen-Verbindung DB-Roundtrip', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    pool = created.pool;
    // eigener Test-User — Tests scopen sich strikt auf eigene Zeilen (CI = echte DB!)
    const [u] = await db
      .insert(schema.users)
      .values({ email: `conn-test-${crypto.randomUUID()}@test.local`, passwordHash: 'x', name: 'Conn Test' })
      .returning();
    userId = u!.id;
  });

  afterAll(async () => {
    if (userId) await db.execute(sql`DELETE FROM users WHERE id = ${userId}`); // cascade räumt Verbindungen
    await pool.end();
  });

  it('connect prüft gegen die (Fake-)Börse, speichert verschlüsselt + maskiert', async () => {
    const dto = await connectExchange(
      db,
      { userId, exchangeId: 'kraken', mode: 'read_only', label: 'Mein Kraken', credentials: { apiKey: 'test-api-key-12345', secret: 'test-secret-6789' } },
      () => fakeClient({ name: 'Kraken' }),
    );
    createdIds.push(dto.id);
    expect(dto.exchangeName).toBe('Kraken');
    expect(dto.keyMasked).toBe('••••••••2345');
    expect(dto.mode).toBe('read_only');
    expect(dto.marketsSummary?.symbolCount).toBe(2);
    // Klartext darf NIE in der DB liegen
    const [row] = await db.select().from(schema.exchangeConnections).where(sql`id = ${dto.id}`);
    expect(row!.encryptedPayload).not.toContain('test-api-key-12345');
    expect(row!.encryptedPayload.startsWith('v1:')).toBe(true);
  });

  it('kaputte Keys werden NICHT gespeichert (Beweis vor Persistenz)', async () => {
    const before = (await listConnections(db, userId)).length;
    await expect(
      connectExchange(
        db,
        { userId, exchangeId: 'kraken', mode: 'read_only', credentials: { apiKey: 'kaputt-key-123', secret: 'kaputt-secret-123' } },
        () => fakeClient({ fetchBalance: async () => { throw new Error('Invalid API key'); } }),
      ),
    ).rejects.toThrow(/fehlgeschlagen/);
    expect((await listConnections(db, userId)).length).toBe(before);
  });

  it('unbekannte Börse wird abgelehnt', async () => {
    await expect(
      connectExchange(db, { userId, exchangeId: 'fantasie', mode: 'read_only', credentials: { apiKey: 'aaaaaaaaaa', secret: 'bbbbbbbbbb' } }, () => fakeClient()),
    ).rejects.toThrow(/nicht unterstützt/);
  });

  it('balances liefert echte Nicht-Null-Bestände, sortiert', async () => {
    const balances = await fetchConnectionBalances(db, userId, createdIds[0]!, () => fakeClient());
    expect(balances.map((b) => b.currency)).toEqual(['USDT', 'BTC']);
    expect(balances[0]).toMatchObject({ currency: 'USDT', total: 1234.5, free: 1000, used: 234.5 });
  });

  it('Fehler beim Balance-Abruf setzt status=error + lastError (ehrlich)', async () => {
    await expect(
      fetchConnectionBalances(db, userId, createdIds[0]!, () => fakeClient({ fetchBalance: async () => { throw new Error('403 IP gesperrt'); } })),
    ).rejects.toThrow(/403/);
    const list = await listConnections(db, userId);
    expect(list.find((c) => c.id === createdIds[0])?.status).toBe('error');
    expect(list.find((c) => c.id === createdIds[0])?.lastError).toContain('403');
    // Heilung beim nächsten erfolgreichen Abruf
    await fetchConnectionBalances(db, userId, createdIds[0]!, () => fakeClient());
    expect((await listConnections(db, userId)).find((c) => c.id === createdIds[0])?.status).toBe('active');
  });

  it('setMode read_only ↔ trading', async () => {
    const dto = await setConnectionMode(db, userId, createdIds[0]!, 'trading');
    expect(dto.mode).toBe('trading');
  });

  it('revoke trennt: Verbindung verschwindet aus der Liste, Payload überschrieben', async () => {
    await revokeConnection(db, userId, createdIds[0]!);
    expect((await listConnections(db, userId)).find((c) => c.id === createdIds[0])).toBeUndefined();
    const [row] = await db.select().from(schema.exchangeConnections).where(sql`id = ${createdIds[0]}`);
    expect(row!.encryptedPayload).toBe('revoked');
    // Folgeoperationen auf getrennter Verbindung → ehrlicher Fehler
    await expect(fetchConnectionBalances(db, userId, createdIds[0]!, () => fakeClient())).rejects.toThrow(/getrennt/);
  });

  it('Wallet verbinden: Adresse wird gegen die echte Börse geprüft, immer read_only, kein Schlüssel', async () => {
    const address = '0x' + 'ab'.repeat(18) + 'cd12';
    let seen: Record<string, string> | null = null;
    const dto = await connectWallet(db, { userId, exchangeId: 'hyperliquid', walletAddress: address, label: 'Mein HL' }, (_id, creds) => {
      seen = creds as unknown as Record<string, string>;
      return fakeClient({ name: 'Hyperliquid' });
    });
    createdIds.push(dto.id);
    expect(seen).toEqual({ walletAddress: address.toLowerCase() });
    expect(dto).toMatchObject({ exchangeId: 'hyperliquid', mode: 'read_only', kind: 'wallet', keyMasked: '0xabab…cd12' });
    // Balances laufen über dieselbe Adresse
    const balances = await fetchConnectionBalances(db, userId, dto.id, (_id, creds) => {
      expect((creds as { walletAddress?: string }).walletAddress).toBe(address.toLowerCase());
      return fakeClient();
    });
    expect(balances[0]?.currency).toBe('USDT');
    // ohne Signatur-Schlüssel kann eine Wallet-Verbindung nie handeln
    await expect(setConnectionMode(db, userId, dto.id, 'trading')).rejects.toThrow(/nur lesend/i);
  });

  it('Wallet: ungültige Adresse / Börse ohne Wallet-Login wird abgelehnt, nichts gespeichert', async () => {
    const before = (await listConnections(db, userId)).length;
    await expect(connectWallet(db, { userId, exchangeId: 'hyperliquid', walletAddress: '0x123' }, () => fakeClient())).rejects.toThrow(/Adresse/);
    await expect(connectWallet(db, { userId, exchangeId: 'kraken', walletAddress: '0x' + 'a'.repeat(40) }, () => fakeClient())).rejects.toThrow(/Wallet/);
    await expect(
      connectWallet(db, { userId, exchangeId: 'hyperliquid', walletAddress: '0x' + 'a'.repeat(40) }, () =>
        fakeClient({ fetchBalance: async () => { throw new Error('user not found'); } }),
      ),
    ).rejects.toThrow(/fehlgeschlagen/);
    expect((await listConnections(db, userId)).length).toBe(before);
  });

  it('fremde userId sieht die Verbindung nicht (Scoping)', async () => {
    const dto = await connectExchange(
      db,
      { userId, exchangeId: 'bybit', mode: 'read_only', credentials: { apiKey: 'other-key-9999', secret: 'other-secret-999' } },
      () => fakeClient(),
    );
    createdIds.push(dto.id);
    const [stranger] = await db
      .insert(schema.users)
      .values({ email: `conn-stranger-${crypto.randomUUID()}@test.local`, passwordHash: 'x', name: 'Stranger' })
      .returning();
    try {
      await expect(fetchConnectionBalances(db, stranger!.id, dto.id, () => fakeClient())).rejects.toThrow(/nicht gefunden/);
      expect(await listConnections(db, stranger!.id)).toEqual([]);
    } finally {
      await db.execute(sql`DELETE FROM users WHERE id = ${stranger!.id}`);
    }
  });
});
