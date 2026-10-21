/**
 * „Heute wichtig" (Design-System v3, Welle B): EINE Liste aus den Dingen, die
 * jetzt Aufmerksamkeit verdienen — offene Signale, bevorstehende Termine mit
 * hohem Impact, ungelesene Ereignisse, offene Optimierungs-Vorschläge. Rein:
 * Eingaben sind bereits normalisiert (keine tRPC-Typen, keine Übersetzung),
 * die Komponente formatiert Titel und Links.
 */

export type TodayKind = 'signal' | 'event' | 'notification' | 'proposal';

export type TodaySignal = { id: string; symbol: string; direction: 'long' | 'short'; score: number; createdAt: string; timeframe: string };
export type TodayEvent = { id: string; title: string; importance: number | null; scheduledAt: string; currency: string | null };
export type TodayNotification = { id: string; kind: string; title: string; createdAt: string; read: boolean; link: string | null };
export type TodayProposal = { id: string; name: string; createdAt: string };

export type TodayItem =
  | { kind: 'signal'; id: string; priority: number; time: string; signal: TodaySignal }
  | { kind: 'event'; id: string; priority: number; time: string; event: TodayEvent; minutesUntil: number }
  | { kind: 'notification'; id: string; priority: number; time: string; notification: TodayNotification }
  | { kind: 'proposal'; id: string; priority: number; time: string; proposal: TodayProposal };

/** Termine zählen nur, wenn sie noch kommen und innerhalb dieses Fensters liegen. */
export const EVENT_WINDOW_MS = 24 * 60 * 60_000;
/** Ungelesene Ereignisse älter als das fallen aus der Liste (sie bleiben in der Glocke). */
export const NOTIFICATION_WINDOW_MS = 48 * 60 * 60_000;

/** Signale: Score 9,5 → 95, plus Frische-Bonus; Termine: hoher Impact kurz vor Eintritt ganz oben. */
export function signalPriority(s: TodaySignal, now: number): number {
  const ageH = Math.max(0, (now - Date.parse(s.createdAt)) / 3_600_000);
  return s.score * 10 + Math.max(0, 10 - ageH);
}

export function eventPriority(e: TodayEvent, now: number): number | null {
  const at = Date.parse(e.scheduledAt);
  if (!Number.isFinite(at) || at < now || at - now > EVENT_WINDOW_MS) return null;
  const imp = e.importance ?? 0;
  if (imp < 2) return null; // nur mittel/hoch
  const hoursUntil = (at - now) / 3_600_000;
  return imp * 30 + Math.max(0, 24 - hoursUntil);
}

export function notificationPriority(n: TodayNotification, now: number): number | null {
  if (n.read) return null;
  if (now - Date.parse(n.createdAt) > NOTIFICATION_WINDOW_MS) return null;
  switch (n.kind) {
    case 'kill_switch':
    case 'emergency':
      return 120;
    case 'price_alert':
      return 70;
    case 'signal':
      return 0; // Signale stehen schon als eigene Zeile drin
    case 'briefing':
      return 20;
    default:
      return 30;
  }
}

export function buildTodayItems(
  input: { signals: TodaySignal[]; events: TodayEvent[]; notifications: TodayNotification[]; proposals: TodayProposal[] },
  now: number,
  limit = 5,
): TodayItem[] {
  const out: TodayItem[] = [];
  for (const s of input.signals) out.push({ kind: 'signal', id: `signal:${s.id}`, priority: signalPriority(s, now), time: s.createdAt, signal: s });
  for (const e of input.events) {
    const p = eventPriority(e, now);
    if (p === null) continue;
    out.push({ kind: 'event', id: `event:${e.id}`, priority: p, time: e.scheduledAt, event: e, minutesUntil: Math.round((Date.parse(e.scheduledAt) - now) / 60_000) });
  }
  // Gleichartige Ereignisse (gleiche Art + Titel, z. B. mehrere ungelesene Briefings) nur einmal — das jüngste.
  const seen = new Set<string>();
  for (const n of [...input.notifications].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    const p = notificationPriority(n, now);
    if (p === null || p === 0) continue;
    const key = `${n.kind}:${n.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'notification', id: `notification:${n.id}`, priority: p, time: n.createdAt, notification: n });
  }
  for (const pr of input.proposals) out.push({ kind: 'proposal', id: `proposal:${pr.id}`, priority: 40, time: pr.createdAt, proposal: pr });
  out.sort((a, b) => b.priority - a.priority || Date.parse(b.time) - Date.parse(a.time));
  return out.slice(0, limit);
}
