import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, Loading, Panel } from './ui.js';
import { appLocale } from '../lib/locale.js';

/**
 * Strategie-Katalog (Patricks Auftrag C): kuratiertes Sortiment mit ECHTEN
 * Backtest-Nachweisen. Karten zeigen NIE behauptete Performance — nur echte
 * Zahlen aus dem 12-Monats-Backtest oder ehrlich „noch nicht geprüft".
 * One-Click: Aktivieren = registrieren → echter Backtest → Validitäts-Gate →
 * Paper (Signale laufen ab dann durch den normalen Mensch-im-Loop-Flow).
 */

type CatalogEntry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number];

const CATEGORIES = ['conservative', 'balanced', 'aggressive'] as const;

const CATEGORY_COLOR: Record<(typeof CATEGORIES)[number], string> = {
  conservative: 'var(--color-cyan)',
  balanced: 'var(--color-violet)',
  aggressive: 'var(--color-warn)',
};

function pct(n: number | null): string {
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${n.toLocaleString(appLocale(), { maximumFractionDigits: 1 })} %`;
}

function CatalogCard({ entry, onChanged }: { entry: CatalogEntry; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const bt = entry.validity.backtest;
  const passed = entry.validity.verdict?.passed ?? false;
  const active = entry.status === 'paper' || entry.status === 'live';

  async function activate() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await trpc.catalog.activate.mutate({ slug: entry.slug });
      if (res.activated) {
        setMessage({ ok: true, text: t('catalog.activated') });
      } else {
        setMessage({ ok: false, text: `${t('catalog.gateFailed')}: ${res.gateReasons?.join(' · ') ?? ''}` });
      }
      onChanged();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    setBusy(true);
    setMessage(null);
    try {
      await trpc.catalog.deactivate.mutate({ slug: entry.slug });
      onChanged();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{t(`catalog.preset_${entry.slugKey}_name`)}</p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t(`catalog.preset_${entry.slugKey}_desc`)}
          </p>
        </div>
        {active && (
          <span className="label shrink-0 rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(34,197,94,0.45)', color: 'var(--color-pos)' }}>
            {t('catalog.active')}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
          {entry.symbol} · {entry.timeframe}
        </span>
        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
          {entry.direction === 'long' ? 'LONG' : 'SHORT'}
        </span>
        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }} title={t('catalog.riskHint')}>
          {t('catalog.risk')}: {entry.riskPctPerTrade} % · {t('ticket.leverage')} ≤ {entry.maxLeverage}×
        </span>
      </div>

      {/* ECHTE Backtest-Zahlen — oder ehrlich „noch nicht geprüft" */}
      {bt ? (
        <div className="mt-3 rounded border p-2.5 text-xs" style={{ borderColor: passed ? 'rgba(34,197,94,0.35)' : 'rgba(245,182,66,0.35)' }}>
          <p style={{ color: 'var(--color-mut)' }}>
            {t('catalog.provenTitle', {
              months: Math.max(1, Math.round((new Date(bt.toTs).getTime() - new Date(bt.fromTs).getTime()) / (30 * 86_400_000))),
            })}
          </p>
          <p className="num mt-1">
            <span style={{ color: (bt.netReturnPct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{pct(bt.netReturnPct)}</span>
            <span style={{ color: 'var(--color-mut)' }}> · {t('catalog.maxDd')} </span>
            <span style={{ color: 'var(--color-neg)' }}>−{bt.maxDrawdownPct?.toLocaleString(appLocale(), { maximumFractionDigits: 1 }) ?? '—'} %</span>
            <span style={{ color: 'var(--color-mut)' }}> · {bt.tradeCount} {t('catalog.trades')}</span>
            {bt.winRate !== null && (
              <span style={{ color: 'var(--color-mut)' }}> · {t('catalog.winRate')} {(bt.winRate * 100).toLocaleString(appLocale(), { maximumFractionDigits: 0 })} %</span>
            )}
          </p>
          {!passed && entry.validity.verdict && (
            <p className="mt-1" style={{ color: 'var(--color-warn)' }}>
              {t('catalog.notValid')}: {entry.validity.verdict.reasons.join(' · ')}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('catalog.notTested')}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {active ? (
          <button className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }} disabled={busy} onClick={() => void deactivate()}>
            {busy ? '…' : t('catalog.deactivate')}
          </button>
        ) : (
          <button className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50" disabled={busy} onClick={() => void activate()}>
            {busy ? t('catalog.activating') : t('catalog.activate')}
          </button>
        )}
      </div>
      {busy && !message && (
        <p className="mt-2 text-[11px] animate-pulse" style={{ color: 'var(--color-mut)' }}>
          {t('catalog.activatingHint')}
        </p>
      )}
      {message && (
        <p className="mt-2 text-[11px]" style={{ color: message.ok ? 'var(--color-pos)' : 'var(--color-warn)' }}>
          {message.text}
        </p>
      )}
    </div>
  );
}

export function StrategyCatalog() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setEntries(await trpc.catalog.list.query());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <Panel stagger={2}>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('catalog.hint')}
      </p>
      {error && (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {entries === null ? (
        <Loading />
      ) : entries.length === 0 ? (
        <Empty text={t('common.empty')} />
      ) : (
        <div className="mt-4 space-y-6">
          {CATEGORIES.map((cat) => (
            <div key={cat}>
              <p className="label mb-2" style={{ color: CATEGORY_COLOR[cat] }}>
                {t(`catalog.cat_${cat}`)}
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                {entries
                  .filter((e) => e.category === cat)
                  .map((e) => (
                    <CatalogCard key={e.slug} entry={e} onChanged={() => void load()} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
