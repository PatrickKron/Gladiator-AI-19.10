import { eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { conditionsSchema, evaluateScreen, MAX_UNIVERSE, MIN_CANDLES, pineTimeframe, SCREEN_CANDLES, tickerIdOf } from '@gladiator/indicators';
import { candleUniverse, getOhlcv } from '@gladiator/market-data';
import { escapeHtml } from './telegram.js';
import { notifySafe, telegramHtmlToText, type NotifyDeps } from './notify.js';

const { screens } = schema;

/**
 * Screen-Alarme (Repo-Masterliste, Phase 2 — „Screen hat neuen Treffer"):
 * Der Worker rechnet alle 5 Minuten jeden gespeicherten Screen mit `alert`
 * auf ECHTEN DB-Kerzen — mit derselben Auswertung wie die Screener-Seite
 * (`evaluateScreen` aus @gladiator/indicators, eine Wahrheit). Gemeldet wird
 * nur, was NEU passt: Symbole, die beim letzten Lauf nicht dabei waren
 * (`screens.last_matches`). Bleibt ein Symbol Treffer, schweigt der Alarm;
 * fällt es raus und kommt wieder, ist es wieder neu. Kerzen werden je Lauf
 * einmal geladen und über alle Screens geteilt.
 */

/** Höchstens so viele Alarm-Screens je Lauf (Rechenzeit im 5-Minuten-Takt). */
export const SCREEN_ALERT_LIMIT = 50;

export type ScreenAlertResult = { screens: number; notified: number; errors: string[] };

/** Neue Treffer = jetzt passend, beim letzten Lauf nicht. Rein, sortiert, ohne Doppelte. */
export function newMatches(previous: readonly string[], current: readonly string[]): string[] {
  const prev = new Set(previous);
  return [...new Set(current.filter((s) => !prev.has(s)))].sort();
}

/** Titel + Telegram-HTML (App/Push bekommen den Klartext daraus). */
export function formatScreenAlert(name: string, timeframe: string, symbols: readonly string[]): { title: string; html: string } {
  const shown = symbols.slice(0, 12);
  const rest = symbols.length - shown.length;
  const list = shown.map((s) => escapeHtml(s)).join(', ') + (rest > 0 ? ` +${rest}` : '');
  return {
    title: `Screen „${name}“: ${symbols.length === 1 ? 'neuer Treffer' : `${symbols.length} neue Treffer`}`,
    html: `🔎 <b>Screen „${escapeHtml(name)}“</b> (${escapeHtml(timeframe)}): ${symbols.length === 1 ? 'neuer Treffer' : 'neue Treffer'} ${list}`,
  };
}

type Candle = Awaited<ReturnType<typeof getOhlcv>>;

export async function runScreenAlerts(db: Db, deps: { notify?: NotifyDeps; now?: () => Date } = {}): Promise<ScreenAlertResult> {
  const result: ScreenAlertResult = { screens: 0, notified: 0, errors: [] };
  const rows = await db.select().from(screens).where(eq(screens.alert, true)).limit(SCREEN_ALERT_LIMIT);
  if (rows.length === 0) return result;

  const universeCache = new Map<string, string[]>();
  const candleCache = new Map<string, Candle>();

  for (const screen of rows) {
    result.screens++;
    const parsed = conditionsSchema.safeParse(screen.conditions);
    if (!parsed.success) {
      result.errors.push(`${screen.name}: Bedingungen ungültig — ${parsed.error.issues[0]?.message ?? 'unbekannt'}`);
      continue;
    }
    const venue = screen.venue;
    const key = `${venue}:${screen.timeframe}`;
    let universe = universeCache.get(key);
    if (!universe) {
      universe = (await candleUniverse(db, { timeframe: screen.timeframe, venue, minCandles: MIN_CANDLES, limit: MAX_UNIVERSE })).map((r) => r.symbol);
      universeCache.set(key, universe);
    }
    const pineTf = pineTimeframe(screen.timeframe);
    const matched: string[] = [];
    for (const symbol of universe) {
      const ck = `${key}:${symbol}`;
      let candles = candleCache.get(ck);
      if (!candles) {
        candles = await getOhlcv(db, { symbol, timeframe: screen.timeframe, limit: SCREEN_CANDLES, venue });
        candleCache.set(ck, candles);
      }
      if (candles.length < MIN_CANDLES) continue;
      try {
        if (evaluateScreen(candles, parsed.data, { timeframe: pineTf, tickerid: tickerIdOf(venue, symbol) }).matches) matched.push(symbol);
      } catch (err) {
        result.errors.push(`${screen.name}/${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const fresh = newMatches(screen.lastMatches ?? [], matched);
    const now = deps.now ? deps.now() : new Date();
    await db
      .update(screens)
      .set({ lastMatches: matched, lastRunAt: now, ...(fresh.length > 0 ? { lastAlertAt: now } : {}) })
      .where(eq(screens.id, screen.id));
    if (fresh.length === 0) continue;
    const { title, html } = formatScreenAlert(screen.name, screen.timeframe, fresh);
    await notifySafe(
      db,
      { userId: screen.userId, kind: 'screen', title, body: telegramHtmlToText(html), link: `#/screener?screen=${screen.id}`, telegramHtml: html },
      deps.notify,
    );
    result.notified++;
  }
  return result;
}
