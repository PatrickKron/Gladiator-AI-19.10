/**
 * Passwort neu setzen ohne das alte (Notfall, nur mit Shell-Zugang zum Server):
 *   npm run auth:set-password -- patrick@example.com
 * Das neue Passwort wird von stdin gelesen (nicht als Argument → nicht in der
 * Shell-History). Alle Sessions werden entwertet, Audit-Eintrag 'auth.password_reset'.
 */
import { createInterface } from 'node:readline/promises';
import { createDb } from '@gladiator/db';
import { setPasswordByEmail } from '../auth/service.js';

const email = process.argv[2];
if (!email) {
  console.error('Aufruf: npm run auth:set-password -- <email>');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
process.stdout.write('Neues Passwort (mind. 10 Zeichen), dann Enter: ');
const password = (await rl.question('')).trim();
rl.close();

const { db, pool } = createDb();
try {
  await setPasswordByEmail(db, email, password);
  console.log(`Passwort für ${email} gesetzt — alle Sitzungen abgemeldet.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
