import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptCredentials, decryptSecret, encryptCredentials, encryptSecret } from './vault.js';

const savedKey = process.env.ENCRYPTION_KEY;
const TEST_KEY = crypto.randomBytes(32).toString('hex');

beforeAll(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

describe('Vault (AES-256-GCM)', () => {
  it('Roundtrip: encrypt → decrypt liefert den Klartext', () => {
    const secret = 'binance-api-key-123:sehr-geheimes-secret';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('zwei Verschlüsselungen desselben Klartexts sind verschieden (zufällige IV)', () => {
    expect(encryptSecret('gleich')).not.toBe(encryptSecret('gleich'));
  });

  it('manipulierter Ciphertext wird abgelehnt (GCM-Authentizität)', () => {
    const payload = encryptSecret('integrität');
    const parts = payload.split(':');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], data.toString('base64')].join(':');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('falscher Schlüssel kann nicht entschlüsseln', () => {
    const payload = encryptSecret('mit-key-A');
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    try {
      expect(() => decryptSecret(payload)).toThrow();
    } finally {
      process.env.ENCRYPTION_KEY = TEST_KEY;
    }
  });

  it('fehlender ENCRYPTION_KEY → Abbruch (kein Default-Key wie in v1)', () => {
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => encryptSecret('x')).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env.ENCRYPTION_KEY = TEST_KEY;
    }
  });

  it('zu kurzer/ungültiger Schlüssel → Abbruch', () => {
    process.env.ENCRYPTION_KEY = 'zu-kurz';
    try {
      expect(() => encryptSecret('x')).toThrow(/64 Hex/);
    } finally {
      process.env.ENCRYPTION_KEY = TEST_KEY;
    }
  });

  it('unbekanntes Payload-Format wird abgelehnt', () => {
    expect(() => decryptSecret('v0:abc')).toThrow(/Format/);
  });

  it('strukturierte Credentials: Roundtrip über JSON', () => {
    const creds = { apiKey: 'key', secret: 'sec', passphrase: 'phrase' };
    expect(decryptCredentials(encryptCredentials(creds))).toEqual(creds);
  });
});
