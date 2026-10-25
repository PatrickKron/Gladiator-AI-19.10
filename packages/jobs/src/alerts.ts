import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type { TradingVenue } from '@gladiator/exchange';
import { latestFreshClose } from '@gladiator/market-data';
import { escapeHtml } from './telegram.js';
import { notifySafe, telegramHtmlToText, type NotifyDeps } from './notify.js';
import { isCandleVenue, type CandleVenue } from './asset-register.js';
import { normalizeTradingPair } from './universe.js';

const { priceAlerts, auditLog } = schema;

/**
 * Preis-Alerts (Patrick-Lücke 7): Monitor prüft minütlich aktive Alerts gegen
 * den ECHTEN Preis. Trigger → Alert deaktiviert, Trigger-Preis als Beleg
 * gespeichert, Telegram + Audit. Kein Polling-Fake.
 * Seit dem Asset-Register (2026-10-25) je Quelle: Binance → venue.markPrice;
 * Yahoo/Twelve Data → Schlusskurs der neuesten FRISCHEN Kerze (Kerzen-Refresh alle
 * 15 min). Veraltete Kerzen lösen nie aus — der Alarm wird übersprungen und gemeldet.
 */

/** Höchstens so viele aktive Alarme je Minuten-Takt (neueste zuerst). */
const ACTIVE_ALERT_LIMIT = 200;

export function alertTriggered(condition: string, targetPrice: number, currentPrice: number): boolean {
  if (condition === 'above') return currentPrice >= targetPrice;
  if (condition === 'below') return currentPrice <= targetPrice;
  return false;
}

/**
 * Preisquelle eines Alarms (rein): gespeicherte Quelle gewinnt; Altbestand ohne Quelle —
 * Krypto-Paar → Binance, sonst die Quelle aus dem Asset-Register, sonst Binance (dann meldet
 * der Markpreis ehrlich einen Fehler statt eines geratenen Kurses).
 */
export function alertSource(alertVenue: string | null | undefined, symbol: string, registeredVenue: string | null | undefined): CandleVenue {
  if (isCandleVenue(alertVenue)) return alertVenue;
  if (normalizeTradingPair(symbol)) return 'binance';
  if (isCandleVenue(registeredVenue)) return registeredVenue;
  return 'binance';
}

export type PriceAlertDeps = { now?: Date; notify?: NotifyDeps };

export async function checkPriceAlerts(
  db: Db,
  venue: Pick<TradingVenue, 'markPrice'>,
  deps: PriceAlertDeps = {},
): Promise<{ checked: number; triggered: number; skipped: string[]; errors: string[] }> {
  const result = { checked: 0, triggered: 0, skipped: [] as string[], errors: [] as string[] };
  const active = await db.select().from(priceAlerts).where(eq(priceAlerts.active, true)).orderBy(desc(priceAlerts.createdAt)).limit(ACTIVE_ALERT_LIMIT);
  if (active.length === 0) return result;

  // Altbestand ohne Quelle: Register-Quelle je Symbol einmal nachschlagen (kein Krypto-Paar).
  const legacy = [...new Set(active.filter((a) => !isCandleVenue(a.venue) && !normalizeTradingPair(a.symbol)).map((a) => a.symbol))];
  const registered = new Map<string, string>();
  if (legacy.length > 0) {
    const rows = await db.execute(
      sql`SELECT DISTINCT ON (data_symbol) data_symbol, candle_venue FROM assets WHERE candle_venue IS NOT NULL AND data_symbol IN (${sql.join(legacy.map((s) => sql`${s}`), sql`, `)}) ORDER BY data_symbol, id`,
    );
    for (const r of rows.rows as { data_symbol: string; candle_venue: string }[]) registered.set(r.data_symbol, r.candle_venue);
  }

  const now = deps.now ?? new Date();
  const prices = new Map<string, number>();
  const keyOf = (src: CandleVenue, symbol: string) => `${src}:${symbol}`;
  for (const a of active) {
    const src = alertSource(a.venue, a.symbol, registered.get(a.symbol));
    const key = keyOf(src, a.symbol);
    if (prices.has(key)) continue;
    try {
      if (src === 'binance') {
        prices.set(key, await venue.markPrice(a.symbol));
        continue;
      }
      const close = await latestFreshClose(db, { venue: src, symbol: a.symbol, now });
      if (close.ok) prices.set(key, close.price);
      else if (close.reason === 'stale') result.skipped.push(`${a.symbol}@${src}: Kerzen veraltet (letzte ${close.lastTs?.toISOString() ?? '—'}) — kein Alarm auf altem Kurs`);
      else result.skipped.push(`${a.symbol}@${src}: keine Kerzen in der DB`);
    } catch (err) {
      result.errors.push(`${a.symbol}@${src}: ${String(err)}`);
    }
  }

  for (const alert of active) {
    const src = alertSource(alert.venue, alert.symbol, registered.get(alert.symbol));
    const price = prices.get(keyOf(src, alert.symbol));
    if (price === undefined) continue;
    result.checked++;
    if (!alertTriggered(alert.condition, Number(alert.price), price)) continue;

    await db
      .update(priceAlerts)
      .set({ active: false, triggeredAt: new Date(), triggeredPrice: String(price) })
      .where(and(eq(priceAlerts.id, alert.id), eq(priceAlerts.active, true)));
    result.triggered++;

    const alertHtml =
      `🔔 <b>Preis-Alert</b> ${escapeHtml(alert.symbol)}: Kurs ${price.toLocaleString('de-DE')} ` +
      `${alert.condition === 'above' ? '≥' : '≤'} Ziel ${Number(alert.price).toLocaleString('de-DE')}` +
      (alert.note ? `\n📝 ${escapeHtml(alert.note)}` : '');
    const venueParam = src === 'binance' ? '' : `&venue=${src}`;
    await notifySafe(
      db,
      {
        userId: alert.userId,
        kind: 'price_alert',
        title: `Preis-Alarm ${alert.symbol}`,
        body: telegramHtmlToText(alertHtml),
        link: `#/charts?symbol=${encodeURIComponent(alert.symbol)}${venueParam}`,
        telegramHtml: alertHtml,
      },
      deps.notify,
    );
    await db.insert(auditLog).values({
      actor: 'system',
      userId: alert.userId,
      action: 'price_alert.triggered',
      entityType: 'price_alert',
      entityId: alert.id,
      details: { symbol: alert.symbol, venue: src, condition: alert.condition, target: alert.price, price },
    });
  }
  return result;
}
