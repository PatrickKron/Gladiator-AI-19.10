/**
 * Selbsthosten, Schritt 3 (nach `npm run db:migrate`): `npm run setup:data` —
 * registriert die Kern-Strategie und lädt ECHTE Kerzen der Basis-Symbole
 * (Binance; bei Standortsperre über den offiziellen Marktdaten-Spiegel).
 * Idempotent: erneut ausführen lädt nur, was fehlt.
 */
import { createDb } from '@gladiator/db';
import { BASE_SYMBOLS, ensureCandles } from '../universe.js';
import { ensureSmcCoreStrategy } from '../signal-scan.js';

const { db, pool } = createDb();
try {
  const core = await ensureSmcCoreStrategy(db);
  console.log(`Kern-Strategie SMC Core bereit (Version ${core.versionId.slice(0, 8)}…).`);
  let failed = 0;
  for (const symbol of BASE_SYMBOLS) {
    const r = await ensureCandles(db, symbol);
    console.log(`${symbol}: ${r.inserted} echte Kerzen geladen${r.errors.length ? ` · Fehler: ${r.errors.join('; ')}` : ''}`);
    if (r.errors.length) failed++;
  }
  if (failed > 0) {
    console.error(`${failed} Symbol(e) mit Fehlern — Netzwerk/Firewall prüfen und erneut ausführen.`);
    process.exitCode = 1;
  } else {
    console.log('Startdaten vollständig. Der Worker hält sie ab jetzt selbst aktuell.');
  }
} finally {
  await pool.end();
}
