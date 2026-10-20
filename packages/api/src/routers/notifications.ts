import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { notify, pushConfig } from '@gladiator/jobs';
import { protectedProcedure, router } from '../trpc.js';

const { notifications, pushSubscriptions } = schema;

/**
 * Benachrichtigungen (Vision-Punkt 3): Glocke in der App + Web-Push je Gerät.
 * Inhalte entstehen ausschließlich in notify() (@gladiator/jobs); hier wird nur
 * gelesen, abgehakt und das Push-Abo des Geräts verwaltet.
 */
export const notificationsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50), unreadOnly: z.boolean().default(false) }).default({}))
    .query(async ({ ctx, input }) => {
      const where = input.unreadOnly
        ? and(eq(notifications.userId, ctx.user.id), isNull(notifications.readAt))
        : eq(notifications.userId, ctx.user.id);
      const rows = await ctx.db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(input.limit);
      return rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
        link: n.link,
        createdAt: n.createdAt.toISOString(),
        read: n.readAt !== null,
      }));
    }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, ctx.user.id), isNull(notifications.readAt)));
    return { unread: Number(row?.n ?? 0) };
  }),

  markRead: protectedProcedure.input(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) })).mutation(async ({ ctx, input }) => {
    await ctx.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, ctx.user.id), inArray(notifications.id, input.ids), isNull(notifications.readAt)));
    return { ok: true };
  }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, ctx.user.id), isNull(notifications.readAt)));
    return { ok: true };
  }),

  /** Push-Status: eingerichtet (VAPID gesetzt)? öffentlicher Schlüssel fürs Abo, Anzahl aktiver Geräte. */
  pushStatus: protectedProcedure.query(async ({ ctx }) => {
    const cfg = pushConfig();
    const [row] = await ctx.db
      .select({ n: count() })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, ctx.user.id), isNull(pushSubscriptions.revokedAt)));
    return { configured: cfg !== null, publicKey: cfg?.publicKey ?? null, devices: Number(row?.n ?? 0) };
  }),

  subscribe: protectedProcedure
    .input(
      z.object({
        endpoint: z.string().url().max(2_000),
        keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(200) }),
        userAgent: z.string().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Ein Gerät = ein Endpoint; erneutes Abo (oder Gerätewechsel des Users) überschreibt
      await ctx.db
        .insert(pushSubscriptions)
        .values({ userId: ctx.user.id, endpoint: input.endpoint, keys: input.keys, userAgent: input.userAgent ?? null })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId: ctx.user.id, keys: input.keys, userAgent: input.userAgent ?? null, revokedAt: null, failureCount: 0 },
        });
      return { ok: true };
    }),

  unsubscribe: protectedProcedure.input(z.object({ endpoint: z.string().url().max(2_000) })).mutation(async ({ ctx, input }) => {
    await ctx.db
      .update(pushSubscriptions)
      .set({ revokedAt: new Date() })
      .where(and(eq(pushSubscriptions.userId, ctx.user.id), eq(pushSubscriptions.endpoint, input.endpoint)));
    return { ok: true };
  }),

  /** Test-Benachrichtigung an alle eigenen Geräte (zeigt ehrlich, ob Push ankommt). */
  test: protectedProcedure.mutation(async ({ ctx }) =>
    notify(ctx.db, {
      userId: ctx.user.id,
      kind: 'system',
      title: 'Gladiator: Test-Benachrichtigung',
      body: 'Wenn du das auf deinem Gerät siehst, funktioniert Push.',
      link: '#/einstellungen',
    }),
  ),
});
