import { createHash } from 'node:crypto';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';

const { economicEvents } = schema;

/**
 * Wirtschaftskalender (09_ §3.7): ForexFactory-Weekly-Feed (frei, kein Key,
 * mit Impact-Rating) → economic_events. High-Impact-Events speisen die
 * No-Trade-Fenster der Risk-Engine. Kaputte Einträge werden verworfen.
 */

/**
 * Zwei freie Wochen-Feeds (kein Key): laufende + nächste Woche. So hat die
 * Monats-/Wochenansicht echten Vorlauf, statt nur die aktuelle Woche zu zeigen.
 * Beide upserten in dieselbe Tabelle (Dedupe über source+externalId).
 */
const FEED_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

export type ParsedEvent = {
  externalId: string;
  title: string;
  country: string | null;
  currency: string | null;
  importance: number | null;
  scheduledAt: Date;
  forecastRaw: string | null;
  previousRaw: string | null;
};

const IMPACT_MAP: Record<string, number> = { high: 3, medium: 2, low: 1, 'non-economic': 1, holiday: 1 };

/** Zahl aus Feed-Strings wie "2.4%", "221K", "-1.4%"; nicht parsebar ⇒ null. */
export function parseEventNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.replaceAll(',', '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let value = Number(m[0]);
  if (/k/i.test(raw)) value *= 1_000;
  else if (/m/i.test(raw)) value *= 1_000_000;
  else if (/b/i.test(raw)) value *= 1_000_000_000;
  return Number.isFinite(value) ? value : null;
}

export function parseForexFactoryFeed(json: unknown): ParsedEvent[] {
  if (!Array.isArray(json)) return [];
  const out: ParsedEvent[] = [];
  for (const raw of json) {
    const e = raw as { title?: string; country?: string; date?: string; impact?: string; forecast?: string; previous?: string };
    if (!e.title || !e.date) continue;
    const scheduledAt = new Date(e.date);
    if (Number.isNaN(scheduledAt.getTime())) continue; // kaputt ⇒ verwerfen, nie raten
    const externalId = createHash('sha256')
      .update(`${e.title}|${e.country ?? ''}|${scheduledAt.toISOString()}`)
      .digest('hex')
      .slice(0, 24);
    out.push({
      externalId,
      title: e.title,
      country: e.country ?? null,
      currency: e.country ?? null, // ForexFactory nutzt Währungscodes im country-Feld
      importance: IMPACT_MAP[(e.impact ?? '').toLowerCase()] ?? null,
      scheduledAt,
      forecastRaw: e.forecast || null,
      previousRaw: e.previous || null,
    });
  }
  return out;
}

export type CalendarSyncResult = { fetched: number; inserted: number; updated: number };

/** Holt die Wochen-Feeds (diese + nächste Woche) und upsertet (Dedupe über source+externalId). */
export async function syncEconomicCalendar(db: Db): Promise<CalendarSyncResult> {
  const events: ParsedEvent[] = [];
  let ok = false;
  for (const url of FEED_URLS) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        console.warn(`[calendar] Feed ${url}: HTTP ${res.status} — übersprungen`);
        continue;
      }
      events.push(...parseForexFactoryFeed(await res.json()));
      ok = true;
    } catch (err) {
      console.warn(`[calendar] Feed ${url} nicht erreichbar:`, String(err));
    }
  }
  // Nur hart abbrechen, wenn KEIN Feed lieferte (sonst ist Teil-Erfolg besser als Fehler).
  if (!ok) throw new Error('Kalender-Feed: kein Wochen-Feed erreichbar.');

  const result: CalendarSyncResult = { fetched: events.length, inserted: 0, updated: 0 };
  for (const e of events) {
    const [existing] = await db
      .select({ id: economicEvents.id })
      .from(economicEvents)
      .where(and(eq(economicEvents.source, 'forexfactory'), eq(economicEvents.externalId, e.externalId)))
      .limit(1);
    if (existing) {
      await db
        .update(economicEvents)
        .set({
          forecast: parseEventNumber(e.forecastRaw) !== null ? String(parseEventNumber(e.forecastRaw)) : null,
          previous: parseEventNumber(e.previousRaw) !== null ? String(parseEventNumber(e.previousRaw)) : null,
          raw: { forecast: e.forecastRaw, previous: e.previousRaw },
          updatedAt: new Date(),
        })
        .where(eq(economicEvents.id, existing.id));
      result.updated++;
    } else {
      await db.insert(economicEvents).values({
        source: 'forexfactory',
        externalId: e.externalId,
        title: e.title,
        country: e.country,
        currency: e.currency,
        importance: e.importance,
        scheduledAt: e.scheduledAt,
        forecast: parseEventNumber(e.forecastRaw) !== null ? String(parseEventNumber(e.forecastRaw)) : null,
        previous: parseEventNumber(e.previousRaw) !== null ? String(parseEventNumber(e.previousRaw)) : null,
        raw: { forecast: e.forecastRaw, previous: e.previousRaw },
      });
      result.inserted++;
    }
  }
  return result;
}

/** Kommende Events (für Kalender-Seite + No-Trade-Fenster). */
export async function upcomingEvents(db: Db, opts: { from?: Date; days?: number } = {}) {
  const from = opts.from ?? new Date();
  const to = new Date(from.getTime() + (opts.days ?? 7) * 86_400_000);
  const rows = await db
    .select()
    .from(economicEvents)
    .where(gte(economicEvents.scheduledAt, new Date(from.getTime() - 2 * 3_600_000)))
    .orderBy(economicEvents.scheduledAt)
    .limit(300);
  return rows.filter((r) => r.scheduledAt <= to);
}

/**
 * Events in einem beliebigen Zeitfenster [from, to] — Basis der Monats-/
 * Wochenansicht. Anders als upcomingEvents auch für die Vergangenheit (bereits
 * synchronisierte Wochen bleiben erhalten und lassen sich zurückblättern).
 */
export async function eventsBetween(db: Db, from: Date, to: Date) {
  return db
    .select()
    .from(economicEvents)
    .where(and(gte(economicEvents.scheduledAt, from), lte(economicEvents.scheduledAt, to)))
    .orderBy(economicEvents.scheduledAt)
    .limit(1000);
}
