/**
 * Agenda-Logik für den Makro-Kalender — PURE Funktionen, bewusst ohne React/tRPC,
 * damit sie unter Vitest (node) ohne Browser testbar sind (gleiche Architektur wie
 * tab-hash.ts / signal-filters.ts).
 *
 * WARUM Agenda statt Monatsgitter: Der ForexFactory-Feed liefert vor allem die
 * laufende Woche — ein 42-Zellen-Gitter ist deshalb fast immer leer und wurde von
 * Patrick als unübersichtlich empfunden. Die Agenda gruppiert nach Tagen, faltet
 * leere Tage zu einer Zeile zusammen und zeigt jedes Event groß und lesbar.
 */

/** Strukturelle Sicht auf ein Kalender-Event — bewusst kein tRPC-Import (pur). */
export type AgendaEventLike = {
  scheduledAt: string | Date;
  importance?: number | null;
  impact?: { severity?: number } | null;
};

/**
 * Anzeige-Impact eines Events: serverseitig klassifizierte severity gewinnt,
 * sonst rohe Feed-importance (1 niedrig … 3 hoch) — identisch zur alten View.
 */
export function severityOf(e: AgendaEventLike): number {
  return e.impact?.severity ?? e.importance ?? 1;
}

/**
 * No-Trade-relevant = importance ≥ 3. WICHTIG: bewusst importance statt severity,
 * weil packages/risk/no-trade.ts (noTradeWindowFor) exakt so filtert — die UI darf
 * nichts als „geblockt" markieren, was die Risk-Engine nicht wirklich blockt.
 */
export function isNoTradeEvent(e: AgendaEventLike): boolean {
  return (e.importance ?? 0) >= 3;
}

/** Event liegt (nach Startzeit) in der Vergangenheit → in der UI gedimmt. */
export function isPast(e: AgendaEventLike, now: Date): boolean {
  return new Date(e.scheduledAt).getTime() < now.getTime();
}

// ── Reine Datums-Helfer (lokale Zeit, wie der Nutzer den Kalender liest) ──────
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Montag der Woche von d (Woche beginnt Montag — europäische Lesart). */
export function startOfWeekMonday(d: Date): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mo=0 … So=6
  return addDays(x, -dow);
}

/** Stabiler lokaler Tages-Schlüssel (yyyy-mm-dd) — Gruppierung + „Heute"-Vergleich. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Agenda-Aufbau ─────────────────────────────────────────────────────────────

/** Ein Abschnitt der Agenda: entweder ein Tag mit Events oder eine zusammengefaltete Lücke. */
export type AgendaSection<T> =
  | { kind: 'day'; date: Date; events: T[] }
  | { kind: 'gap'; from: Date; to: Date; days: number };

/**
 * Baut die Agenda für [rangeStart, rangeEndExclusive): Tage mit Events werden zu
 * 'day'-Abschnitten (Events zeitlich sortiert), zusammenhängende leere Tage zu
 * EINEM 'gap'-Abschnitt gefaltet — auch am Rand des Zeitraums, damit ehrlich
 * sichtbar bleibt, wie viel der Feed (noch) nicht abdeckt.
 * `pinned` (typisch: heute) wird IMMER als Tag gezeigt, auch ohne Events —
 * der Nutzer braucht den „Heute"-Anker zum Orientieren.
 */
export function buildAgenda<T extends AgendaEventLike>(
  events: T[],
  rangeStart: Date,
  rangeEndExclusive: Date,
  pinned?: Date,
): AgendaSection<T>[] {
  const byDay = new Map<string, T[]>();
  for (const e of events) {
    const k = dayKey(new Date(e.scheduledAt));
    const list = byDay.get(k) ?? [];
    list.push(e);
    byDay.set(k, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  }

  const pinnedKey = pinned ? dayKey(pinned) : null;
  const out: AgendaSection<T>[] = [];
  let gapStart: Date | null = null;

  const flushGap = (endInclusive: Date) => {
    if (!gapStart) return;
    const days = Math.round((startOfDay(endInclusive).getTime() - gapStart.getTime()) / 86_400_000) + 1;
    out.push({ kind: 'gap', from: gapStart, to: startOfDay(endInclusive), days });
    gapStart = null;
  };

  for (let d = startOfDay(rangeStart); d.getTime() < rangeEndExclusive.getTime(); d = addDays(d, 1)) {
    const k = dayKey(d);
    const list = byDay.get(k) ?? [];
    if (list.length > 0 || k === pinnedKey) {
      flushGap(addDays(d, -1));
      out.push({ kind: 'day', date: d, events: list });
    } else if (!gapStart) {
      gapStart = d;
    }
  }
  flushGap(addDays(rangeEndExclusive, -1));
  return out;
}

// ── Countdown / nächstes High-Impact-Event ────────────────────────────────────

/**
 * Restzeit bis target als {h, m} — null wenn target vorbei ist.
 * {h:0, m:0} bedeutet „unter einer Minute" (UI zeigt dann „jetzt gleich").
 */
export function countdownParts(target: Date, now: Date): { h: number; m: number } | null {
  const diff = target.getTime() - now.getTime();
  if (diff <= 0) return null;
  const totalMin = Math.floor(diff / 60_000);
  return { h: Math.floor(totalMin / 60), m: totalMin % 60 };
}

/**
 * Nächstes ZUKÜNFTIGES High-Impact-Event (Anzeige-severity ≥ 3) — dorthin kommt
 * der Live-Countdown. Nur aus real geladenen Events, nichts wird erfunden.
 */
export function nextHighImpact<T extends AgendaEventLike>(events: T[], now: Date): T | null {
  let best: T | null = null;
  let bestTime = Infinity;
  for (const e of events) {
    if (severityOf(e) < 3) continue;
    const ts = new Date(e.scheduledAt).getTime();
    if (ts <= now.getTime() || ts >= bestTime) continue;
    best = e;
    bestTime = ts;
  }
  return best;
}
