import crypto from 'node:crypto';
import { requireEnv } from '@gladiator/db';

/**
 * Vault für Börsen-/Wallet-Keys: AES-256-GCM at-rest (10_ §2).
 * - Schlüssel kommt AUSSCHLIESSLICH aus ENCRYPTION_KEY (64 Hex-Zeichen = 256 Bit).
 *   Fehlt er oder ist er zu kurz → Abbruch. KEIN Default-Key (Alt-Fehler
 *   'default-key-32-characters-long!' in v1).
 * - GCM liefert Authentizität: manipulierte Ciphertexte fliegen beim Entschlüsseln auf.
 * - Format: "v1:<iv b64>:<authTag b64>:<ciphertext b64>" → Spalte exchange_credentials.encrypted_payload.
 */

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;

function loadKey(): Buffer {
  const hex = requireEnv('ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY muss exakt 64 Hex-Zeichen (256 Bit) sein — Abbruch.');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error(`Vault: unbekanntes Payload-Format (erwartet "${FORMAT_VERSION}:iv:tag:data").`);
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, loadKey(), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64')), decipher.final()]).toString('utf8');
}

/** Bequemer Wrapper für strukturierte Credentials (API-Key + Secret + optional Passphrase). */
export function encryptCredentials(creds: Record<string, string>): string {
  return encryptSecret(JSON.stringify(creds));
}

export function decryptCredentials(payload: string): Record<string, string> {
  return JSON.parse(decryptSecret(payload)) as Record<string, string>;
}
