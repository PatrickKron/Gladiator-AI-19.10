import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { schema, type Db } from '@gladiator/db';
import { protectedProcedure, router } from '../trpc.js';

const { auditLog, assetFavorites, demoOrders, pushSubscriptions, exchangeConnections, appSecrets } = schema;

/**
 * Einrichtungs-Fortschritt (Welle F, „Dein Start — n von 5"): jeder Schritt ist ein
 * ECHTER Zustand aus der DB, nichts wird gemerkt oder geschätzt:
 *   risk       — Risiko-Regeln mindestens einmal gespeichert (Audit `settings.update`)
 *   watch      — mindestens ein Favorit (Meine Märkte)
 *   paperTrade — mindestens eine Demo-Order
 *   notify     — aktives Web-Push-Abo ODER Telegram (Bot-Token + Chat-ID in Vault/.env)
 *   exchange   — mindestens eine nicht widerrufene Börsen-Verbindung
 */
export const SETUP_STEP_IDS = ['risk', 'watch', 'paperTrade', 'notify', 'exchange'] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

async function any(q: Promise<{ n: number }[]>): Promise<boolean> {
  const [row] = await q;
  return Number(row?.n ?? 0) > 0;
}

async function telegramConfigured(db: Db): Promise<boolean> {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) return true;
  const rows = await db
    .select({ key: appSecrets.key })
    .from(appSecrets)
    .where(inArray(appSecrets.key, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']));
  const keys = new Set(rows.map((r) => r.key));
  return keys.has('TELEGRAM_BOT_TOKEN') && keys.has('TELEGRAM_CHAT_ID');
}

export async function setupProgress(db: Db, userId: string) {
  const [risk, watch, paperTrade, push, exchange, telegram] = await Promise.all([
    any(db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'settings.update')))),
    any(db.select({ n: count() }).from(assetFavorites).where(eq(assetFavorites.userId, userId))),
    any(db.select({ n: count() }).from(demoOrders).where(eq(demoOrders.userId, userId))),
    any(db.select({ n: count() }).from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)))),
    any(db.select({ n: count() }).from(exchangeConnections).where(and(eq(exchangeConnections.userId, userId), ne(exchangeConnections.status, 'revoked')))),
    telegramConfigured(db),
  ]);
  const done: Record<SetupStepId, boolean> = { risk, watch, paperTrade, notify: push || telegram, exchange };
  const steps = SETUP_STEP_IDS.map((id) => ({ id, done: done[id] }));
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

export const setupRouter = router({
  /** Stand der Einrichtung des angemeldeten Nutzers — nur Zählungen, keine Secrets. */
  progress: protectedProcedure.query(({ ctx }) => setupProgress(ctx.db, ctx.user.id)),
});
