/**
 * Selbsthosten, Schritt 1: `npm run setup:env` — erzeugt die `.env` im Repo-Root
 * aus `.env.example` mit zufälligen Pflicht-Geheimnissen + Web-Push-Schlüsseln.
 * Eine vorhandene `.env` wird NIE überschrieben (Abbruch mit Hinweis).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import webpush from 'web-push';
import { fillEnvFromExample } from '../setup-env.js';

const root = resolve(import.meta.dirname, '../../../..');
const target = resolve(root, '.env');
if (existsSync(target)) {
  console.error('.env existiert bereits — nichts überschrieben. Zum Neuaufsetzen erst sichern/umbenennen.');
  process.exit(1);
}
const env = fillEnvFromExample(readFileSync(resolve(root, '.env.example'), 'utf8'), {
  hex: (bytes) => randomBytes(bytes).toString('hex'),
  password: () => randomBytes(24).toString('base64url'),
  vapid: () => webpush.generateVAPIDKeys(),
});
writeFileSync(target, env, { mode: 0o600 });
console.log('.env angelegt (nur für dich lesbar): DB-Passwort, JWT, Vault-Schlüssel und Web-Push sind gesetzt.');
console.log('Optional eintragen: ANTHROPIC_API_KEY, Börsen-Zugänge, TELEGRAM_* — siehe Kommentare in der .env.');
