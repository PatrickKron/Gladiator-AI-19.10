import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
import { formatKillSwitchAlert, notifySafe, telegramHtmlToText } from '@gladiator/jobs';
import { SETTINGS_BOUNDS } from '@gladiator/core/trading-settings';
import { protectedProcedure, router } from '../trpc.js';

const { tradingSettings, auditLog } = schema;

/**
 * Trading-Einstellungen (09_ §3.10): greifen DIREKT in die Risk-Engine —
 * loadRiskSettings liest exakt diese Zeile vor jeder Order-Prüfung.
 * Modus bleibt hart 'paper' (Live-Freigabe erst Phase 7, pro Börse).
 */

// Grenzen aus @gladiator/core (eine Quelle mit den Profilen der Oberfläche)
const b = SETTINGS_BOUNDS;
const settingsInput = z.object({
  riskPctPerTrade: z.number().min(b.riskPctPerTrade.min).max(b.riskPctPerTrade.max),
  maxLeverage: z.number().min(b.maxLeverage.min).max(b.maxLeverage.max),
  maxOpenPositions: z.number().int().min(b.maxOpenPositions.min).max(b.maxOpenPositions.max),
  maxExposurePctPerAsset: z.number().min(b.maxExposurePctPerAsset.min).max(b.maxExposurePctPerAsset.max),
  dailyLossLimitPct: z.number().min(b.dailyLossLimitPct.min).max(b.dailyLossLimitPct.max),
  weeklyLossLimitPct: z.number().min(b.weeklyLossLimitPct.min).max(b.weeklyLossLimitPct.max),
  maxDrawdownPct: z.number().min(b.maxDrawdownPct.min).max(b.maxDrawdownPct.max),
});

async function ensureRow(ctx: { db: Db; user: { id: string } }) {
  const [row] = await ctx.db.select().from(tradingSettings).where(eq(tradingSettings.userId, ctx.user.id)).limit(1);
  if (row) return row;
  const [created] = await ctx.db.insert(tradingSettings).values({ userId: ctx.user.id }).returning();
  return created!;
}

export const settingsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const row = await ensureRow(ctx);
    return {
      riskPctPerTrade: Number(row.riskPctPerTrade),
      maxLeverage: Number(row.maxLeverage),
      maxOpenPositions: row.maxOpenPositions,
      maxExposurePctPerAsset: Number(row.maxExposurePctPerAsset),
      dailyLossLimitPct: Number(row.dailyLossLimitPct),
      weeklyLossLimitPct: Number(row.weeklyLossLimitPct),
      maxDrawdownPct: Number(row.maxDrawdownPct),
      killSwitchActive: row.killSwitchActive,
      mode: row.mode,
      updatedAt: row.updatedAt,
    };
  }),

  update: protectedProcedure.input(settingsInput).mutation(async ({ ctx, input }) => {
    await ensureRow(ctx);
    const [updated] = await ctx.db
      .update(tradingSettings)
      .set({
        riskPctPerTrade: String(input.riskPctPerTrade),
        maxLeverage: String(input.maxLeverage),
        maxOpenPositions: input.maxOpenPositions,
        maxExposurePctPerAsset: String(input.maxExposurePctPerAsset),
        dailyLossLimitPct: String(input.dailyLossLimitPct),
        weeklyLossLimitPct: String(input.weeklyLossLimitPct),
        maxDrawdownPct: String(input.maxDrawdownPct),
        updatedAt: new Date(),
      })
      .where(eq(tradingSettings.userId, ctx.user.id))
      .returning();
    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: 'settings.update',
      entityType: 'trading_settings',
      entityId: updated!.id,
      details: input,
      ip: ctx.ip,
    });
    return { ok: true };
  }),

  /** Kill-Switch (SAFE): sofortiger Order-Stopp — jede Änderung auditiert. */
  setKillSwitch: protectedProcedure
    .input(z.object({ active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ensureRow(ctx);
      const [updated] = await ctx.db
        .update(tradingSettings)
        .set({ killSwitchActive: input.active, updatedAt: new Date() })
        .where(eq(tradingSettings.userId, ctx.user.id))
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: input.active ? 'risk.kill_switch.on' : 'risk.kill_switch.off',
        entityType: 'trading_settings',
        entityId: updated!.id,
        details: { active: input.active },
        ip: ctx.ip,
      });
      // Benachrichtigung (App + Push + optional Telegram) — Versand-Fehler blockieren den Schalter nie.
      const killHtml = formatKillSwitchAlert(input.active, ctx.user.email);
      void notifySafe(ctx.db, {
        userId: ctx.user.id,
        kind: 'kill_switch',
        severity: input.active ? 'critical' : 'warn',
        title: input.active ? 'Kill-Switch AKTIV' : 'Kill-Switch aus',
        body: telegramHtmlToText(killHtml),
        link: '#/einstellungen',
        telegramHtml: killHtml,
      });
      return { killSwitchActive: updated!.killSwitchActive };
    }),
});

/** Trading-Einstellungen des Nutzers (legt die Standard-Zeile an, falls sie fehlt) — für Asset-Analyse und Chat. */
export function ensureTradingSettings(db: Db, userId: string) {
  return ensureRow({ db, user: { id: userId } });
}
