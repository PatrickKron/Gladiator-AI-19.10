import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { sendTelegram as sendTelegramDefault } from './telegram.js';

const { users, notifications, pushSubscriptions } = schema;

/**
 * Benachrichtigungen (Vision-Punkt 3): EINE Funktion für alle Ereignisse.
 * 1. Zeile in `notifications` (Glocke in der App) — immer.
 * 2. Web-Push an jedes registrierte Gerät — wenn VAPID-Schlüssel gesetzt sind;
 *    abgelaufene Abos (404/410) werden widerrufen, andere Fehler gezählt.
 * 3. Telegram — nur wenn ein Text dafür übergeben wird und der Bot konfiguriert ist.
 * Ohne userId geht das Ereignis an alle Nutzer (System-Ereignisse).
 */

export type NotifyKind = 'signal' | 'price_alert' | 'screen' | 'emergency' | 'kill_switch' | 'briefing' | 'system';

export type NotifyEvent = {
  kind: NotifyKind;
  title: string;
  body: string;
  link?: string | null;
  severity?: 'info' | 'warn' | 'critical';
  userId?: string;
  /** Optionaler Telegram-Text (HTML, bestehende Formatierer). */
  telegramHtml?: string;
};

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushSender = (sub: PushTarget, payload: string) => Promise<void>;

export type NotifyDeps = {
  sendPush?: PushSender;
  sendTelegram?: (html: string) => Promise<boolean>;
  /** Überschreibt die Erkennung über die Umgebung (Tests). */
  pushConfigured?: boolean;
};

const MAX_BODY = 1_000;

/** Telegram-HTML → Klartext für App und Push (gleicher Inhalt, ohne Tags). */
export function telegramHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Benachrichtigen darf den Aufrufer nie stoppen (Review, Monitor, Kill-Switch). */
export async function notifySafe(db: Db, ev: NotifyEvent, deps?: NotifyDeps): Promise<void> {
  try {
    await notify(db, ev, deps);
  } catch (err) {
    console.warn(`[notify] ${ev.kind} nicht zugestellt: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function pushPayload(n: { id: string; title: string; body: string; link: string | null; severity: string }): string {
  const body = n.body.length > MAX_BODY ? `${n.body.slice(0, MAX_BODY - 1)}…` : n.body;
  return JSON.stringify({ id: n.id, title: n.title, body, link: n.link, severity: n.severity });
}

/** VAPID aus der Umgebung; ohne beide Schlüssel ist Push ehrlich „nicht eingerichtet“. */
export function pushConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost' };
}

const defaultSendPush: PushSender = async (sub, payload) => {
  const cfg = pushConfig();
  if (!cfg) throw new Error('Web-Push nicht eingerichtet (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY fehlen).');
  await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
    vapidDetails: cfg,
    TTL: 3_600,
  });
};

function statusOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === 'number' ? code : null;
}

export async function notify(
  db: Db,
  ev: NotifyEvent,
  deps: NotifyDeps = {},
): Promise<{ created: number; pushed: number; pushFailed: number; removed: number; telegram: boolean | null }> {
  const sendPush = deps.sendPush ?? defaultSendPush;
  const pushOn = deps.pushConfigured ?? pushConfig() !== null;

  const targets = ev.userId ? [ev.userId] : (await db.select({ id: users.id }).from(users)).map((u) => u.id);
  const out = { created: 0, pushed: 0, pushFailed: 0, removed: 0, telegram: null as boolean | null };
  if (targets.length > 0) {
    const rows = await db
      .insert(notifications)
      .values(
        targets.map((userId) => ({
          userId,
          kind: ev.kind,
          severity: ev.severity ?? 'info',
          title: ev.title,
          body: ev.body,
          link: ev.link ?? null,
        })),
      )
      .returning();
    out.created = rows.length;

    if (pushOn) {
      const subs = await db
        .select()
        .from(pushSubscriptions)
        .where(and(inArray(pushSubscriptions.userId, targets), isNull(pushSubscriptions.revokedAt)));
      for (const sub of subs) {
        const row = rows.find((r) => r.userId === sub.userId)!;
        try {
          await sendPush({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, pushPayload(row));
          out.pushed++;
          await db.update(pushSubscriptions).set({ lastSuccessAt: new Date(), failureCount: 0 }).where(eq(pushSubscriptions.id, sub.id));
        } catch (err) {
          out.pushFailed++;
          const code = statusOf(err);
          if (code === 404 || code === 410) {
            await db.update(pushSubscriptions).set({ revokedAt: new Date() }).where(eq(pushSubscriptions.id, sub.id));
            out.removed++;
          } else {
            await db
              .update(pushSubscriptions)
              .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
              .where(eq(pushSubscriptions.id, sub.id));
          }
        }
      }
    }
  }

  if (ev.telegramHtml) out.telegram = await (deps.sendTelegram ?? sendTelegramDefault)(ev.telegramHtml);
  return out;
}
