import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';

const { signals } = schema;

/**
 * Signal-Ablauf: ein unbestätigtes ('new') Signal beschreibt ein Setup nahe am
 * damaligen Preis. Nach einer timeframe-abhängigen Frist ist der Einstieg
 * veraltet — das Signal läuft auf Status 'expired' und verschwindet aus der
 * „offen"-Liste (weniger Rauschen, nur echt aktuelle Signale bleiben sichtbar).
 * Rein zeitbasiert, keine erfundenen Daten. Wird zu Beginn jedes 5-min-Scans
 * ausgeführt.
 */

/** Frist in Stunden je Timeframe (menschlich lesbar, leicht anpassbar). */
export const SIGNAL_TTL_HOURS: Record<string, number> = {
  '15m': 4,
  '1h': 12,
  '4h': 48,
  '1d': 120,
};

/** Sichere Standard-Frist für nicht gelistete Timeframes. */
export const DEFAULT_TTL_HOURS = 24;

export function ttlHoursFor(timeframe: string): number {
  return SIGNAL_TTL_HOURS[timeframe] ?? DEFAULT_TTL_HOURS;
}

/** Zeitpunkt, VOR dem ein 'new'-Signal dieses Timeframes als abgelaufen gilt. */
export function signalExpiryCutoff(timeframe: string, now = new Date()): Date {
  return new Date(now.getTime() - ttlHoursFor(timeframe) * 3_600_000);
}

/** Ist ein 'new'-Signal (erstellt zu createdAt) zum Zeitpunkt now abgelaufen? */
export function isSignalExpired(createdAt: Date, timeframe: string, now = new Date()): boolean {
  return createdAt.getTime() < signalExpiryCutoff(timeframe, now).getTime();
}

/**
 * Setzt alle überfälligen 'new'-Signale auf 'expired' (je Timeframe eigene
 * Frist). Nur 'new' — bestätigte/gefüllte/geschlossene Signale sind im
 * Trade-Lifecycle und werden nicht angefasst. Liefert die Anzahl abgelaufener.
 */
export async function expireStaleSignals(db: Db, now = new Date()): Promise<number> {
  let expired = 0;
  // Bekannte Timeframes mit eigener Frist
  for (const [timeframe] of Object.entries(SIGNAL_TTL_HOURS)) {
    const res = await db
      .update(signals)
      .set({ status: 'expired', updatedAt: now })
      .where(and(eq(signals.status, 'new'), eq(signals.timeframe, timeframe), lt(signals.createdAt, signalExpiryCutoff(timeframe, now))));
    expired += res.rowCount ?? 0;
  }
  // Nicht gelistete Timeframes: Standard-Frist (kein Signal bleibt ewig 'new')
  const knownTfs = Object.keys(SIGNAL_TTL_HOURS);
  const defaultCutoff = new Date(now.getTime() - DEFAULT_TTL_HOURS * 3_600_000);
  const resOther = await db
    .update(signals)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(signals.status, 'new'),
        lt(signals.createdAt, defaultCutoff),
        sql`${signals.timeframe} NOT IN (${sql.join(knownTfs.map((t) => sql`${t}`), sql`, `)})`,
      ),
    );
  expired += resOther.rowCount ?? 0;
  return expired;
}
