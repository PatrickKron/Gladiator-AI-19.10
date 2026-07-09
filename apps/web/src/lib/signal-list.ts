import { decodeFilters, encodeFilters, type SignalFilters } from './signal-filters.js';

/**
 * Reine Helfer für die Signal-LISTE (Zeilen-Ansicht statt Karten-Grid).
 * Bewusst ohne React/DOM, damit alles unter Vitest (node) testbar ist.
 *
 * Hintergrund (Live-Befund 2026-07-09): Der Risk-Agent lehnt real ALLE
 * Signale hart ab (Margin > Konto, Exposure > 20-%-Limit) — „Bestätigen"
 * wird vom Risk-Gate deshalb praktisch immer geblockt. Die Liste muss das
 * VOR dem Klick ehrlich zeigen; dafür extrahiert `swarmVerdict` das harte
 * Risk-Veto separat aus den Schwarm-Urteilen.
 */

/** Ablauf-Frist je Timeframe in Stunden — Spiegel der Backend-Regel (signal-expiry.ts), wie in SignalCard. */
export const TTL_HOURS: Record<string, number> = { '15m': 4, '1h': 12, '4h': 48, '1d': 120 };

export type ReviewLite = {
  agent: string;
  vote: 'confirm' | 'reject' | 'caution';
  confidence: number;
  reason: string;
};

export type SwarmVerdictInfo = {
  /** Gesamturteil: Portfolio-Agent (finale Instanz) gewinnt; sonst das schlechteste Einzelurteil. null = noch kein Review. */
  vote: 'confirm' | 'caution' | 'reject' | null;
  /** Konfidenz des Gesamturteils (0..1) — null, wenn kein Review vorliegt. */
  confidence: number | null;
  /** Grund des HARTEN Risk-Vetos — null, wenn der Risk-Agent nicht ablehnt. Muss VOR dem Klick sichtbar sein. */
  riskReject: string | null;
  /** Einzelurteile in Anzeige-Reihenfolge (Portfolio zuletzt) für den Tooltip. */
  lines: ReviewLite[];
};

/** Rangfolge fürs „schlechteste Urteil gewinnt"-Aggregat (ohne Portfolio-Agent). */
const VOTE_RANK: Record<ReviewLite['vote'], number> = { reject: 2, caution: 1, confirm: 0 };

/**
 * Verdichtet die Schwarm-Reviews zu einem Kurzurteil für die Zeile.
 * Das Risk-Veto wird separat gemeldet, weil es das Risk-Gate beim
 * Bestätigen hart durchsetzt — die UI erklärt damit den Button-Zustand.
 */
export function swarmVerdict(reviews: ReviewLite[]): SwarmVerdictInfo {
  if (reviews.length === 0) return { vote: null, confidence: null, riskReject: null, lines: [] };
  const portfolio = reviews.find((r) => r.agent === 'portfolio') ?? null;
  const singles = reviews.filter((r) => r.agent !== 'portfolio');
  const risk = reviews.find((r) => r.agent === 'risk' && r.vote === 'reject') ?? null;

  let vote: SwarmVerdictInfo['vote'];
  let confidence: number | null;
  if (portfolio) {
    vote = portfolio.vote;
    confidence = portfolio.confidence;
  } else {
    // Kein Portfolio-Review (z. B. älterer Datenstand): konservativ das schlechteste Urteil nehmen.
    const worst = singles.reduce<ReviewLite | null>(
      (acc, r) => (acc === null || VOTE_RANK[r.vote] > VOTE_RANK[acc.vote] ? r : acc),
      null,
    );
    vote = worst?.vote ?? null;
    confidence = worst?.confidence ?? null;
  }
  return { vote, confidence, riskReject: risk?.reason ?? null, lines: [...singles, ...(portfolio ? [portfolio] : [])] };
}

/**
 * Listen-Sortierung laut Vorgabe: neueste zuerst, Abgelaufene ans Ende
 * (werden dort gedimmt dargestellt). Gibt zwei getrennte, je für sich
 * zeitlich absteigend sortierte Blöcke zurück.
 */
export function splitByExpiry<T extends { status: string; createdAt: string | Date }>(rows: T[]): { active: T[]; expired: T[] } {
  const ts = (r: T) => new Date(r.createdAt).getTime();
  const byNewest = (a: T, b: T) => ts(b) - ts(a);
  return {
    active: rows.filter((r) => r.status !== 'expired').sort(byNewest),
    expired: rows.filter((r) => r.status === 'expired').sort(byNewest),
  };
}

/** Verbleibende Gültigkeit in ms (negativ = überfällig, läuft mit dem nächsten Scan ab). */
export function expiryLeftMs(createdAt: string | Date, timeframe: string, nowMs: number): number {
  const ttlMs = (TTL_HOURS[timeframe] ?? 24) * 3_600_000;
  return ttlMs - (nowMs - new Date(createdAt).getTime());
}

/** Kompakte Dauer-Anzeige: „5 min" / „3 h" / „2 T" — bewusst grob, die Zeile soll scanbar bleiben. */
export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h} h`;
  return `${Math.round(ms / 86_400_000)} T`;
}

/** Alter eines Signals relativ zu jetzt (für „vor {{time}}"). */
export function ageText(createdAt: string | Date, nowMs: number): string {
  return formatDuration(Math.max(0, nowMs - new Date(createdAt).getTime()));
}

/**
 * Filter-Persistenz für die LISTE: Default-Status ist hier „all"
 * (die Liste zeigt alles, Abgelaufene gedimmt am Ende) — anders als
 * DEFAULT_FILTERS aus signal-filters.ts (dort „new"). Die Wrapper
 * übersetzen zwischen beiden Welten, OHNE signal-filters.ts anzufassen
 * (Regel: additiv, gemeinsame Module unverändert).
 */
export function encodeListFilters(f: SignalFilters): string {
  const p = new URLSearchParams(encodeFilters(f));
  // encodeFilters lässt „new" weg (dort Default) — für die Liste ist „new" aber
  // eine explizite Wahl und muss den Reload überleben.
  if (f.status === 'new') p.set('status', 'new');
  // „all" ist der Listen-Default → aus der URL halten (kurze, saubere Links).
  if (f.status === 'all') p.delete('status');
  return p.toString();
}

export function decodeListFilters(hash: string): SignalFilters {
  const f = decodeFilters(hash);
  const q = hash.indexOf('?');
  const p = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
  if (!p.get('status')) f.status = 'all';
  return f;
}
