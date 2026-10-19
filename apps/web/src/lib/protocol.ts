/**
 * Reine Helfer für Protokoll (Audit-Log) und Steuer-Export — kein React, kein
 * DOM → vollständig getestet (protocol.test.ts).
 */

/** Aktions-Präfixe der sicherheitsrelevanten Bereiche (Filter-Vorgaben). */
export const AUDIT_ACTION_PREFIXES = [
  'order.',
  'position.',
  'auth.',
  'risk.',
  'settings.',
  'signal.',
  'strategy.',
  'sub_agent.',
  'venue.',
  'exchange.',
  'secret.',
] as const;

export type AuditFilterForm = { action: string; entity: string; from: string; to: string };

export type AuditQuery = { actionPrefix?: string; entityType?: string; from?: string; to?: string };

/** `YYYY-MM-DD` als lokaler Tag → Date (Tagesbeginn bzw. -ende); ungültig → null. */
function localDay(value: string, endOfDay: boolean): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = endOfDay
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
    : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Formularfelder → Input für `system.auditLog` (leere Felder fallen weg). */
export function auditQuery(form: AuditFilterForm): AuditQuery {
  const q: AuditQuery = {};
  if (form.action.trim()) q.actionPrefix = form.action.trim();
  if (form.entity.trim()) q.entityType = form.entity.trim();
  const from = localDay(form.from, false);
  const to = localDay(form.to, true);
  if (from) q.from = from.toISOString();
  if (to) q.to = to.toISOString();
  return q;
}

/** Wählbare Steuerjahre: aktuelles Jahr und die vier davor. */
export function exportYears(now: Date = new Date()): number[] {
  const y = now.getFullYear();
  return [y, y - 1, y - 2, y - 3, y - 4];
}

export function tradesCsvFilename(year: number | null): string {
  return `gladiator-trades-${year ?? 'alle'}.csv`;
}
