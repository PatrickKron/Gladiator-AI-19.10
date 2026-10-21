import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';
import { AUDIT_ACTION_PREFIXES, auditQuery, type AuditFilterForm, type AuditQuery } from '../lib/protocol.js';
import { appLocale } from '../lib/locale.js';

/**
 * Protokoll (10_ §6): das unveränderliche Audit-Log — jede sicherheitsrelevante
 * Aktion (Orders, Risk-Checks, SL/TP-Änderungen, Logins) mit Zeit, Aktion,
 * Objekt und Details. Nur lesend, echte Einträge aus `audit_log`.
 */

type AuditPage = Awaited<ReturnType<typeof trpc.system.auditLog.query>>;
type AuditItem = AuditPage['items'][number];

const PAGE_SIZE = 50;
const EMPTY_FORM: AuditFilterForm = { action: '', entity: '', from: '', to: '' };

function DetailsCell({ details }: { details: unknown }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (details === null || details === undefined) return <span style={{ color: 'var(--color-mut)' }}>—</span>;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="text-xs" style={{ color: 'var(--color-cyan)' }} aria-expanded={open}>
        {open ? t('protocol.hideDetails') : t('protocol.showDetails')}
      </button>
      {open && (
        <pre
          className="num mt-1.5 max-h-72 max-w-[36rem] overflow-auto rounded-[0.5rem] border p-2 text-xs leading-relaxed whitespace-pre-wrap break-all"
          style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
        >
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function Protokoll() {
  const { t } = useTranslation();
  const [form, setForm] = useState<AuditFilterForm>(EMPTY_FORM);
  const [query, setQuery] = useState<AuditQuery>({});
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(q: AuditQuery, after: string | null) {
    setBusy(true);
    try {
      const res = await trpc.system.auditLog.query({ ...q, limit: PAGE_SIZE, ...(after ? { cursor: after } : {}) });
      setItems((prev) => (after && prev ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      if (!after) setItems([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(query, null);
  }, [query]);

  function apply() {
    setItems(null);
    setQuery(auditQuery(form));
  }

  function reset() {
    setForm(EMPTY_FORM);
    setItems(null);
    setQuery({});
  }

  return (
    <div>
      <PageHeader title={t('protocol.title')} subtitle={t('protocol.subtitle')} />
      {error && <ErrorBox message={error} />}

      <Panel label={t('protocol.filterTitle')} stagger={1}>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <label className="text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('protocol.filterAction')}
            <select
              value={form.action}
              onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
              className="field mt-1.5 w-full cursor-pointer px-2.5 py-2 text-sm"
            >
              <option value="">{t('protocol.all')}</option>
              {AUDIT_ACTION_PREFIXES.map((p) => (
                <option key={p} value={p}>
                  {p}*
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('protocol.filterEntity')}
            <input
              value={form.entity}
              onChange={(e) => setForm((f) => ({ ...f, entity: e.target.value }))}
              placeholder={t('protocol.entityPlaceholder')}
              className="field mt-1.5 w-full px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('protocol.filterFrom')}
            <input
              type="date"
              value={form.from}
              onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
              className="field num mt-1.5 w-full px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('protocol.filterTo')}
            <input
              type="date"
              value={form.to}
              onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
              className="field num mt-1.5 w-full px-3 py-2 text-sm"
            />
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary px-4 py-2 text-sm" disabled={busy}>
              {t('protocol.apply')}
            </button>
            <button type="button" onClick={reset} className="text-sm" style={{ color: 'var(--color-mut)' }}>
              {t('protocol.reset')}
            </button>
          </div>
        </form>
      </Panel>

      <Panel label={t('protocol.listTitle')} stagger={2} className="mt-5">
        {items === null ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty text={t('protocol.empty')} />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal">{t('protocol.colTime')}</th>
                  <th className="py-1.5 pr-3 font-normal">{t('protocol.colAction')}</th>
                  <th className="py-1.5 pr-3 font-normal">{t('protocol.colActor')}</th>
                  <th className="py-1.5 pr-3 font-normal">{t('protocol.colEntity')}</th>
                  <th className="py-1.5 font-normal">{t('protocol.colDetails')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="align-top" style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                    <td className="num py-1.5 pr-3 whitespace-nowrap">
                      {new Date(r.ts).toLocaleString(appLocale(), { dateStyle: 'short', timeStyle: 'medium' })}
                    </td>
                    <td className="num py-1.5 pr-3">{r.action}</td>
                    <td className="py-1.5 pr-3" style={{ color: 'var(--color-mut)' }}>
                      {r.actor}
                    </td>
                    <td className="py-1.5 pr-3">
                      {r.entityType ?? '—'}
                      {r.entityId && (
                        <span className="num ml-1.5 text-xs" style={{ color: 'var(--color-mut)' }} title={r.entityId}>
                          {r.entityId.length > 12 ? `${r.entityId.slice(0, 8)}…` : r.entityId}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">
                      <DetailsCell details={r.details} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cursor && (
              <button
                onClick={() => void load(query, cursor)}
                disabled={busy}
                className="mt-4 text-sm"
                style={{ color: 'var(--color-cyan)' }}
              >
                {busy ? t('common.loading') : t('protocol.loadMore')}
              </button>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
