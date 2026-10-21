/**
 * Mehrfach-Charts (Repo-Masterliste, Phase 3b): Fadenkreuz und sichtbarer
 * Zeitbereich laufen über alle Zellen eines Layouts mit. Reiner Bus ohne DOM:
 * Mitglieder einer Gruppe bekommen, was die anderen senden — nie das eigene.
 * Die Zeit (Sekunden) ist der gemeinsame Nenner, auch bei verschiedenen Zeitrahmen.
 */

export type SyncEvent = { kind: 'crosshair'; time: number | null } | { kind: 'range'; from: number; to: number };
export type SyncListener = (ev: SyncEvent) => void;

type Member = { id: symbol; fn: SyncListener };
const groups = new Map<string, Set<Member>>();

export function joinSyncGroup(group: string, fn: SyncListener): { publish: (ev: SyncEvent) => void; leave: () => void } {
  const me: Member = { id: Symbol(group), fn };
  let set = groups.get(group);
  if (!set) {
    set = new Set();
    groups.set(group, set);
  }
  set.add(me);
  return {
    publish: (ev) => {
      for (const m of groups.get(group) ?? []) if (m !== me) m.fn(ev);
    },
    leave: () => {
      const s = groups.get(group);
      if (!s) return;
      s.delete(me);
      if (s.size === 0) groups.delete(group);
    },
  };
}

/** Anzahl Mitglieder (Tests, Diagnose). */
export function syncGroupSize(group: string): number {
  return groups.get(group)?.size ?? 0;
}

/**
 * Index der Kerze, in die der Zeitpunkt fällt: die letzte Kerze mit Startzeit ≤ t
 * (aufsteigend sortierte Sekunden). −1 vor der ersten Kerze; nach der letzten
 * zählt die letzte nur, wenn t noch innerhalb eines Kerzenabstands liegt.
 */
export function barIndexAt(times: readonly number[], t: number): number {
  if (times.length === 0 || t < times[0]!) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  if (lo === times.length - 1 && times.length > 1) {
    const step = times[lo]! - times[lo - 1]!;
    if (t >= times[lo]! + step) return -1;
  }
  return lo;
}
