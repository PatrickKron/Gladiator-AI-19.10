import { and, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type { TradingVenue } from '@gladiator/exchange';
import { escapeHtml, sendTelegram } from './telegram.js';

const { priceAlerts, auditLog } = schema;

/**
 * Preis-Alerts (Patrick-Lücke 7): Monitor prüft minütlich aktive Alerts gegen
 * den ECHTEN Markpreis (venue.markPrice). Trigger → Alert deaktiviert,
 * Trigger-Preis als Beleg gespeichert, Telegram + Audit. Kein Polling-Fake.
 */

export function alertTriggered(condition: string, targetPrice: number, currentPrice: number): boolean {
  if (condition === 'above') return currentPrice >= targetPrice;
  if (condition === 'below') return currentPrice <= targetPrice;
  return false;
}

export async function checkPriceAlerts(db: Db, venue: TradingVenue): Promise<{ checked: number; triggered: number; errors: string[] }> {
  const result = { checked: 0, triggered: 0, errors: [] as string[] };
  const active = await db.select().from(priceAlerts).where(eq(priceAlerts.active, true)).limit(50);
  if (active.length === 0) return result;

  const prices = new Map<string, number>();
  for (const symbol of new Set(active.map((a) => a.symbol))) {
    try {
      prices.set(symbol, await venue.markPrice(symbol));
    } catch (err) {
      result.errors.push(`${symbol}: ${String(err)}`);
    }
  }

  for (const alert of active) {
    const price = prices.get(alert.symbol);
    if (price === undefined) continue;
    result.checked++;
    if (!alertTriggered(alert.condition, Number(alert.price), price)) continue;

    await db
      .update(priceAlerts)
      .set({ active: false, triggeredAt: new Date(), triggeredPrice: String(price) })
      .where(and(eq(priceAlerts.id, alert.id), eq(priceAlerts.active, true)));
    result.triggered++;

    await sendTelegram(
      `🔔 <b>Preis-Alert</b> ${escapeHtml(alert.symbol)}: Kurs ${price.toLocaleString('de-DE')} ` +
        `${alert.condition === 'above' ? '≥' : '≤'} Ziel ${Number(alert.price).toLocaleString('de-DE')}` +
        (alert.note ? `\n📝 ${escapeHtml(alert.note)}` : ''),
    );
    await db.insert(auditLog).values({
      actor: 'system',
      userId: alert.userId,
      action: 'price_alert.triggered',
      entityType: 'price_alert',
      entityId: alert.id,
      details: { symbol: alert.symbol, condition: alert.condition, target: alert.price, price },
    });
  }
  return result;
}
