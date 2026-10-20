/* global process, console, URL */
// Legt die Test-Datenbank für die Server-CI an, falls sie fehlt (idempotent).
// Aufruf: node scripts/ensure-test-db.mjs  (liest TEST_DATABASE_URL + DATABASE_URL)
// Sicherung: bricht ab, wenn Test- und Live-Datenbank identisch wären.
import pg from 'pg';

const testUrl = process.env.TEST_DATABASE_URL;
const liveUrl = process.env.DATABASE_URL;
if (!testUrl) {
  console.error('TEST_DATABASE_URL fehlt.');
  process.exit(1);
}
const test = new URL(testUrl);
const dbName = decodeURIComponent(test.pathname.replace(/^\//, ''));
if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
  console.error(`Ungültiger Datenbankname "${dbName}".`);
  process.exit(1);
}
if (liveUrl) {
  const live = new URL(liveUrl);
  if (live.host === test.host && live.pathname === test.pathname) {
    console.error('TEST_DATABASE_URL zeigt auf die Live-Datenbank — Abbruch.');
    process.exit(1);
  }
}

const admin = new URL(testUrl);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Test-Datenbank ${dbName} angelegt.`);
  } else {
    console.log(`Test-Datenbank ${dbName} vorhanden.`);
  }
} finally {
  await client.end();
}
