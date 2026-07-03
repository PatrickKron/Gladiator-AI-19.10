import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import {
  SECRET_KEYS,
  captureBootEnv,
  deleteSecret,
  getSecretStatus,
  loadSecretsIntoEnv,
  maskSecret,
  setSecret,
  validateSecretValue,
} from './secrets.js';

/**
 * UI-gepflegte Secrets (Patrick ohne SSH): Vault-verschlüsselt in der DB,
 * DB überschreibt .env, maskierte Anzeige, Boot-Snapshot-Restore. TDD.
 */

if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64); // testkontrolliert — Boot-Pflicht bleibt unberührt
}

describe('validateSecretValue (pur)', () => {
  it('Telegram-Token: Format erzwungen, kompromittierter v1-Token VERWEIGERT', () => {
    expect(validateSecretValue('TELEGRAM_BOT_TOKEN', '8123456789:AAH' + 'x'.repeat(30))).toBeNull();
    expect(validateSecretValue('TELEGRAM_BOT_TOKEN', 'kein-token')).toMatch(/Format/);
    expect(validateSecretValue('TELEGRAM_BOT_TOKEN', '7544725601:AAF' + 'x'.repeat(30))).toMatch(/kompromittiert/i);
  });

  it('Hyperliquid: Adresse 0x+40 hex, Agent-Key 0x+64 hex', () => {
    expect(validateSecretValue('HYPERLIQUID_TESTNET_WALLET', '0x' + '1'.repeat(40))).toBeNull();
    expect(validateSecretValue('HYPERLIQUID_TESTNET_WALLET', '0x' + '1'.repeat(64))).toMatch(/Format/);
    expect(validateSecretValue('HYPERLIQUID_TESTNET_AGENT_KEY', '0x' + '2'.repeat(64))).toBeNull();
    expect(validateSecretValue('HYPERLIQUID_TESTNET_AGENT_KEY', '0x' + '2'.repeat(40))).toMatch(/Format/);
  });

  it('Anthropic sk-ant-Präfix, Healthchecks nur https, Pine min. 16 Zeichen', () => {
    expect(validateSecretValue('ANTHROPIC_API_KEY', 'sk-ant-' + 'x'.repeat(30))).toBeNull();
    expect(validateSecretValue('ANTHROPIC_API_KEY', 'sk-proj-falsch')).toMatch(/sk-ant/);
    expect(validateSecretValue('HEALTHCHECKS_URL', 'https://hc-ping.com/abc')).toBeNull();
    expect(validateSecretValue('HEALTHCHECKS_URL', 'http://unsicher.example')).toMatch(/https/);
    expect(validateSecretValue('PINE_WEBHOOK_SECRET', 'kurz')).toMatch(/16/);
  });

  it('unbekannter Key wird abgelehnt (Whitelist)', () => {
    expect(validateSecretValue('BOESER_KEY' as never, 'wert')).toMatch(/unbekannt/i);
  });
});

describe('maskSecret', () => {
  it('zeigt nur die letzten 4 Zeichen', () => {
    expect(maskSecret('abcd')).toBe('••••••••abcd');
    expect(maskSecret('xy')).toBe('••••••••xy');
  });
});

// ── DB-Roundtrip (Server-CI; lokal ohne DATABASE_URL übersprungen) ────────

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[secrets.test] DATABASE_URL nicht gesetzt — DB-Teil übersprungen.');

describe.skipIf(!hasDb)('Secrets-Store (Vault-verschlüsselt, DB > .env)', () => {
  let db: Db;
  let pool: pg.Pool;
  const KEY = 'FRED_API_KEY' as const;
  const VALUE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // 32 hex-artig, valide
  let envBackup: string | undefined;

  beforeAll(() => {
    ({ db, pool } = createDb());
    envBackup = process.env[KEY];
  });

  afterAll(async () => {
    await deleteSecret(db, KEY).catch(() => {});
    if (envBackup === undefined) delete process.env[KEY];
    else process.env[KEY] = envBackup;
    await pool.end();
  });

  it('setSecret: verschlüsselt in DB (kein Klartext!), spiegelt nach process.env', async () => {
    delete process.env[KEY];
    captureBootEnv();
    await setSecret(db, KEY, VALUE, null);

    const { appSecrets } = schema;
    const [row] = await db.select().from(appSecrets).where((await import('drizzle-orm')).eq(appSecrets.key, KEY));
    expect(row).toBeTruthy();
    expect(row!.ciphertext).not.toContain(VALUE); // NIE Klartext in der DB
    expect(row!.ciphertext.startsWith('v1:')).toBe(true); // Vault-Format
    expect(row!.last4).toBe(VALUE.slice(-4));
    expect(process.env[KEY]).toBe(VALUE); // sofort wirksam im Prozess
  });

  it('getSecretStatus: Quelle db, maskiert, nie der Klartext', async () => {
    const status = await getSecretStatus(db);
    const entry = status.find((s) => s.key === KEY)!;
    expect(entry.source).toBe('db');
    expect(entry.masked).toBe(maskSecret(VALUE.slice(-4)));
    expect(JSON.stringify(entry)).not.toContain(VALUE);
  });

  it('ungültiger Wert wird abgelehnt und NICHT gespeichert', async () => {
    await expect(setSecret(db, 'TELEGRAM_BOT_TOKEN', '7544725601:AAFalt' + 'x'.repeat(20), null)).rejects.toThrow(/kompromittiert/i);
  });

  it('loadSecretsIntoEnv: DB-Wert überschreibt .env-Wert', async () => {
    process.env[KEY] = 'env-wert-nicht-nutzen';
    const loaded = await loadSecretsIntoEnv(db);
    expect(loaded).toContain(KEY);
    expect(process.env[KEY]).toBe(VALUE);
  });

  it('deleteSecret: Zeile weg, process.env fällt auf Boot-Snapshot zurück', async () => {
    await deleteSecret(db, KEY);
    const status = await getSecretStatus(db);
    expect(status.find((s) => s.key === KEY)!.source).not.toBe('db');
    // Boot-Snapshot war "nicht gesetzt" (captureBootEnv oben nach delete) → Key entfernt
    expect(process.env[KEY]).toBeUndefined();
  });

  it('Registry: alle 10 geforderten Keys sind verwaltbar', () => {
    const keys = SECRET_KEYS.map((k) => k.key);
    for (const required of [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'ANTHROPIC_API_KEY',
      'PINE_WEBHOOK_SECRET',
      'BINANCE_TESTNET_KEY',
      'BINANCE_TESTNET_SECRET',
      'HYPERLIQUID_TESTNET_WALLET',
      'HYPERLIQUID_TESTNET_AGENT_KEY',
      'HEALTHCHECKS_URL',
      'FRED_API_KEY',
    ]) {
      expect(keys).toContain(required);
    }
  });
});
