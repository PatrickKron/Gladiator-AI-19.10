import { eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { decryptSecret, encryptSecret } from './vault.js';

const { appSecrets } = schema;

/**
 * UI-gepflegte App-Secrets (Phase 7+): Patrick trägt API-Keys in der
 * Einstellungen-Seite ein — ohne SSH, ohne Code.
 *
 * Sicherheitsmodell:
 * - At-rest AUSSCHLIESSLICH Vault-verschlüsselt (AES-256-GCM, ENCRYPTION_KEY
 *   aus der Server-.env — einmalig gesetzt, Boot bricht ohne ihn ab).
 * - In der DB liegen nur Ciphertext + last4 (maskierte Anzeige). NIE Klartext,
 *   auch nicht in Logs/Audit (dort nur last4).
 * - Auflösung: DB überschreibt .env. Beim Boot lädt loadSecretsIntoEnv() alle
 *   DB-Werte nach process.env (VOR der Venue-Konstruktion); Änderungen zur
 *   Laufzeit spiegeln sofort nach process.env — Call-Time-Konsumenten
 *   (Telegram, LLM, Pine-Webhook, FRED, Dead-Man-Ping) wirken sofort.
 *   Boot-Time-Konsumenten (Börsen-Venues) brauchen einen Dienst-Neustart —
 *   ehrlich als „wirkt nach Neustart" markiert + Neustart-Button in der UI.
 */

export type SecretKey =
  | 'TELEGRAM_BOT_TOKEN'
  | 'TELEGRAM_CHAT_ID'
  | 'ANTHROPIC_API_KEY'
  | 'PINE_WEBHOOK_SECRET'
  | 'BINANCE_TESTNET_KEY'
  | 'BINANCE_TESTNET_SECRET'
  | 'HYPERLIQUID_TESTNET_WALLET'
  | 'HYPERLIQUID_TESTNET_AGENT_KEY'
  | 'HEALTHCHECKS_URL'
  | 'FRED_API_KEY'
  | 'TWELVE_DATA_API_KEY';

export type SecretDef = {
  key: SecretKey;
  /** true = wirkt sofort (Call-Time-Leser); false = wirkt nach Dienst-Neustart (Boot-Time). */
  immediate: boolean;
  /** Gibt es einen ECHTEN externen Funktionstest? (Pine z. B. nicht.) */
  testable: boolean;
  validate: (value: string) => string | null;
};

const COMPROMISED_TELEGRAM_PREFIX = '7544725601:';

export const SECRET_KEYS: SecretDef[] = [
  {
    key: 'TELEGRAM_BOT_TOKEN',
    immediate: true,
    testable: true,
    validate: (v) => {
      if (v.startsWith(COMPROMISED_TELEGRAM_PREFIX)) {
        return 'Dieser Token ist der KOMPROMITTIERTE v1-Token (10_ §1) — bitte via BotFather widerrufen und einen NEUEN Bot-Token eintragen.';
      }
      return /^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(v) ? null : 'Format ungültig — erwartet „<Bot-ID>:<Token>" von BotFather.';
    },
  },
  {
    key: 'TELEGRAM_CHAT_ID',
    immediate: true,
    testable: true,
    validate: (v) => (/^-?\d{5,16}$/.test(v) ? null : 'Format ungültig — Chat-ID ist eine Zahl (ggf. mit Minus).'),
  },
  {
    key: 'ANTHROPIC_API_KEY',
    immediate: true,
    testable: true,
    validate: (v) => (v.startsWith('sk-ant-') && v.length > 20 ? null : 'Format ungültig — Anthropic-Keys beginnen mit „sk-ant-".'),
  },
  {
    key: 'PINE_WEBHOOK_SECRET',
    immediate: true,
    testable: false,
    validate: (v) => (v.length >= 16 ? null : 'Zu kurz — mindestens 16 Zeichen (langes Zufallssecret).'),
  },
  {
    key: 'BINANCE_TESTNET_KEY',
    immediate: false,
    testable: true,
    validate: (v) => (/^[A-Za-z0-9]{16,}$/.test(v) ? null : 'Format ungültig — alphanumerisch, mindestens 16 Zeichen.'),
  },
  {
    key: 'BINANCE_TESTNET_SECRET',
    immediate: false,
    testable: true,
    validate: (v) => (v.length >= 16 ? null : 'Zu kurz — mindestens 16 Zeichen.'),
  },
  {
    key: 'HYPERLIQUID_TESTNET_WALLET',
    immediate: false,
    testable: true,
    validate: (v) => (/^0x[0-9a-fA-F]{40}$/.test(v) ? null : 'Format ungültig — Wallet-ADRESSE ist 0x + 40 Hex-Zeichen.'),
  },
  {
    key: 'HYPERLIQUID_TESTNET_AGENT_KEY',
    immediate: false,
    testable: true,
    validate: (v) =>
      /^0x[0-9a-fA-F]{64}$/.test(v) ? null : 'Format ungültig — AGENT-Key (nie der Haupt-Wallet-Key!) ist 0x + 64 Hex-Zeichen.',
  },
  {
    key: 'HEALTHCHECKS_URL',
    immediate: true,
    testable: true,
    validate: (v) => {
      try {
        const url = new URL(v);
        return url.protocol === 'https:' ? null : 'Nur https-URLs erlaubt.';
      } catch {
        return 'Keine gültige URL.';
      }
    },
  },
  {
    key: 'FRED_API_KEY',
    immediate: true,
    testable: true,
    validate: (v) => (/^[a-z0-9]{16,64}$/.test(v) ? null : 'Format ungültig — FRED-Keys sind 32 Kleinbuchstaben/Ziffern.'),
  },
  {
    key: 'TWELVE_DATA_API_KEY',
    immediate: true, // Call-Time-Leser (Ingest liest process.env bei jedem Lauf)
    testable: true,
    validate: (v) => (/^[A-Za-z0-9]{16,64}$/.test(v) ? null : 'Format ungültig — Twelve-Data-Keys sind alphanumerisch (32 Zeichen).'),
  },
];

export function secretDef(key: string): SecretDef | null {
  return SECRET_KEYS.find((d) => d.key === key) ?? null;
}

/** Validiert Wert gegen die Whitelist-Regeln. null = ok, sonst Fehlertext. */
export function validateSecretValue(key: SecretKey, value: string): string | null {
  const def = secretDef(key);
  if (!def) return `Key unbekannt — nur die ${SECRET_KEYS.length} Whitelist-Keys sind verwaltbar.`;
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Wert ist leer.';
  return def.validate(trimmed);
}

export function maskSecret(last4: string): string {
  return `••••••••${last4}`;
}

/** Snapshot der .env-Werte VOR den DB-Overrides — für Restore bei Löschung. */
let bootEnv: Partial<Record<SecretKey, string | undefined>> = {};
export function captureBootEnv(): void {
  bootEnv = {};
  for (const def of SECRET_KEYS) bootEnv[def.key] = process.env[def.key];
}

/** Boot: alle DB-Secrets entschlüsseln → process.env (DB überschreibt .env). */
export async function loadSecretsIntoEnv(db: Db): Promise<SecretKey[]> {
  const rows = await db.select().from(appSecrets);
  const loaded: SecretKey[] = [];
  for (const row of rows) {
    const def = secretDef(row.key);
    if (!def) continue; // unbekannte Alt-Zeile — ignorieren, nie raten
    try {
      process.env[def.key] = decryptSecret(row.ciphertext);
      loaded.push(def.key);
    } catch (err) {
      console.error(`[secrets] ${row.key}: Entschlüsselung fehlgeschlagen (ENCRYPTION_KEY geändert?):`, String(err));
    }
  }
  return loaded;
}

export async function setSecret(db: Db, key: SecretKey, value: string, userId: string | null): Promise<{ last4: string }> {
  const trimmed = value.trim();
  const error = validateSecretValue(key, trimmed);
  if (error) throw new Error(error);
  const last4 = trimmed.slice(-4);
  await db
    .insert(appSecrets)
    .values({ key, ciphertext: encryptSecret(trimmed), last4, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSecrets.key,
      set: { ciphertext: encryptSecret(trimmed), last4, updatedBy: userId, updatedAt: new Date() },
    });
  process.env[key] = trimmed; // sofort wirksam für Call-Time-Leser
  return { last4 };
}

export async function deleteSecret(db: Db, key: SecretKey): Promise<void> {
  await db.delete(appSecrets).where(eq(appSecrets.key, key));
  // Zurück auf den .env-Stand vom Boot (oder entfernen, wenn dort nicht gesetzt)
  const bootValue = bootEnv[key];
  if (bootValue === undefined) delete process.env[key];
  else process.env[key] = bootValue;
}

export type SecretStatus = {
  key: SecretKey;
  source: 'db' | 'env' | null;
  masked: string | null;
  immediate: boolean;
  testable: boolean;
  updatedAt: Date | null;
};

export async function getSecretStatus(db: Db): Promise<SecretStatus[]> {
  const rows = await db.select().from(appSecrets);
  return SECRET_KEYS.map((def) => {
    const row = rows.find((r) => r.key === def.key);
    if (row) {
      return { key: def.key, source: 'db' as const, masked: maskSecret(row.last4), immediate: def.immediate, testable: def.testable, updatedAt: row.updatedAt };
    }
    const envValue = bootEnv[def.key] ?? process.env[def.key];
    if (envValue) {
      return { key: def.key, source: 'env' as const, masked: maskSecret(envValue.slice(-4)), immediate: def.immediate, testable: def.testable, updatedAt: null };
    }
    return { key: def.key, source: null, masked: null, immediate: def.immediate, testable: def.testable, updatedAt: null };
  });
}
