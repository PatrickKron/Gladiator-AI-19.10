import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DSL_TIMEFRAMES, type DslTimeframe } from '@gladiator/strategy-engine';
import { trpc } from '../api.js';
import { Empty, Loading, Panel } from './ui.js';
import { appLocale } from '../lib/locale.js';

/**
 * Strategie-Katalog (Patricks Auftrag C + Welle 4): kuratiertes Sortiment mit
 * transparenten Einstiegs-/SL-/TP-Regeln, frei wählbarem Ziel-Asset (Krypto,
 * Aktien, ETFs, Forex, Rohstoffe), 1-Klick-Übernahme in den KI-Workshop und
 * ECHTEN Backtest-Nachweisen.
 */

type CatalogEntry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number];

const CATEGORIES = ['conservative', 'balanced', 'aggressive'] as const;

const CATEGORY_COLOR: Record<(typeof CATEGORIES)[number], string> = {
  conservative: 'var(--color-cyan)',
  balanced: 'var(--color-violet)',
  aggressive: 'var(--color-warn)',
};

const QUICK_MULTI_ASSET_SYMBOLS = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'XAU/USD',
  'EUR/USD',
  'SPY',
  'QQQ',
  'AAPL',
  'NVDA',
];

function pct(n: number | null): string {
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${n.toLocaleString(appLocale(), { maximumFractionDigits: 1 })} %`;
}

function CatalogCard({
  entry,
  targetSymbol,
  targetTimeframe,
  onChanged,
}: {
  entry: CatalogEntry;
  targetSymbol: string;
  targetTimeframe: DslTimeframe | '';
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [workshopBusy, setWorkshopBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const bt = entry.validity.backtest;
  const passed = entry.validity.verdict?.passed ?? false;
  const active = entry.status === 'paper' || entry.status === 'live';

  const effectiveSymbol = targetSymbol.trim() ? targetSymbol.trim().toUpperCase() : entry.symbol;
  const effectiveTimeframe: DslTimeframe = targetTimeframe || entry.timeframe;
  const isCustomTarget = effectiveSymbol !== entry.symbol || effectiveTimeframe !== entry.timeframe;
  const rules = entry.ruleSummary;

  async function activate() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await trpc.catalog.activate.mutate({
        slug: entry.slug,
        ...(isCustomTarget ? { symbol: effectiveSymbol, timeframe: effectiveTimeframe } : {}),
      });
      if (res.activated) {
        setMessage({
          ok: true,
          text: `${t('catalog.activated')} (${res.symbol ?? effectiveSymbol} · ${res.timeframe ?? effectiveTimeframe})`,
        });
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

  async function openInWorkshop() {
    setWorkshopBusy(true);
    setMessage(null);
    try {
      const res = await trpc.catalog.openInWorkshop.mutate({
        slug: entry.slug,
        symbol: effectiveSymbol,
        timeframe: effectiveTimeframe,
      });
      window.location.hash = `#/strategien?tab=workshop&session=${res.sessionId}`;
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setWorkshopBusy(false);
    }
  }

  return (
    <div className="glass flex flex-col justify-between p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{t(`catalog.preset_${entry.slugKey}_name`)}</p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-mut)' }}>
              {t(`catalog.preset_${entry.slugKey}_desc`)}
            </p>
          </div>
          {active && !isCustomTarget && (
            <span
              className="label shrink-0 rounded border px-1.5 py-0.5"
              style={{ borderColor: 'rgba(34,197,94,0.45)', color: 'var(--color-pos)' }}
            >
              {t('catalog.active')}
            </span>
          )}
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
          <span
            className="rounded border px-1.5 py-0.5 font-medium"
            style={{
              borderColor: isCustomTarget ? 'var(--color-cyan)' : 'var(--color-line)',
              color: isCustomTarget ? 'var(--color-cyan)' : 'var(--color-fg)',
            }}
          >
            {effectiveSymbol} · {effectiveTimeframe}
          </span>
          <span
            className="rounded border px-1.5 py-0.5 font-medium"
            style={{
              borderColor: 'var(--color-line)',
              color: entry.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)',
            }}
          >
            {entry.direction === 'long' ? 'LONG' : 'SHORT'}
          </span>
          <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }} title={t('catalog.riskHint')}>
            {t('catalog.risk')}: {entry.riskPctPerTrade} % · {t('ticket.leverage')} ≤ {entry.maxLeverage}×
          </span>
        </div>

        {/* Transparente Strategie-Regeln (Welle 4: Bedingungen, Entry, SL, TP) */}
        {rules && (
          <div
            className="mt-3 rounded border p-2.5 text-[11px] space-y-1.5"
            style={{ borderColor: 'var(--color-line)', backgroundColor: 'rgba(255,255,255,0.02)' }}
          >
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-medium" style={{ color: 'var(--color-mut)' }}>
                {t('catalog.rulesEntry')}:
              </span>
              {rules.conditions.map((cond, idx) => (
                <span
                  key={idx}
                  className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                  style={{ backgroundColor: 'rgba(6, 182, 212, 0.12)', color: 'var(--color-cyan)' }}
                >
                  {cond}
                </span>
              ))}
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                style={{ backgroundColor: 'rgba(168, 85, 247, 0.14)', color: 'var(--color-violet)' }}
              >
                {rules.entry}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: 'var(--color-mut)' }}>
              <span>
                <strong style={{ color: 'var(--color-neg)' }}>SL:</strong> {rules.stopLoss}
              </span>
              <span>
                <strong style={{ color: 'var(--color-pos)' }}>TP:</strong> {rules.takeProfits}
              </span>
              {rules.trailingStop && (
                <span style={{ color: 'var(--color-cyan)' }}>{rules.trailingStop}</span>
              )}
            </div>
          </div>
        )}

        {/* ECHTE Backtest-Zahlen — oder ehrlich „noch nicht geprüft" */}
        {bt ? (
          <div
            className="mt-3 rounded border p-2.5 text-xs"
            style={{ borderColor: passed ? 'rgba(34,197,94,0.35)' : 'rgba(245,182,66,0.35)' }}
          >
            <p style={{ color: 'var(--color-mut)' }}>
              {t('catalog.provenTitle', {
                months: Math.max(
                  1,
                  Math.round((new Date(bt.toTs).getTime() - new Date(bt.fromTs).getTime()) / (30 * 86_400_000)),
                ),
              })}
            </p>
            <p className="num mt-1">
              <span style={{ color: (bt.netReturnPct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                {pct(bt.netReturnPct)}
              </span>
              <span style={{ color: 'var(--color-mut)' }}> · {t('catalog.maxDd')} </span>
              <span style={{ color: 'var(--color-neg)' }}>
                −{bt.maxDrawdownPct?.toLocaleString(appLocale(), { maximumFractionDigits: 1 }) ?? '—'} %
              </span>
              <span style={{ color: 'var(--color-mut)' }}>
                {' '}
                · {bt.tradeCount} {t('catalog.trades')}
              </span>
              {bt.winRate !== null && (
                <span style={{ color: 'var(--color-mut)' }}>
                  {' '}
                  · {t('catalog.winRate')}{' '}
                  {(bt.winRate * 100).toLocaleString(appLocale(), { maximumFractionDigits: 0 })} %
                </span>
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
      </div>

      <div className="mt-3 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          {active && !isCustomTarget ? (
            <button
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              disabled={busy}
              onClick={() => void deactivate()}
            >
              {busy ? '…' : t('catalog.deactivate')}
            </button>
          ) : (
            <button
              className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              disabled={busy || workshopBusy}
              onClick={() => void activate()}
            >
              {busy
                ? t('catalog.activating')
                : isCustomTarget
                  ? `${t('catalog.activateOn')} ${effectiveSymbol}`
                  : t('catalog.activate')}
            </button>
          )}
          <button
            type="button"
            className="rounded-[0.625rem] border px-2.5 py-1.5 text-xs transition-colors hover:border-cyan-400/60 disabled:opacity-50"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
            disabled={busy || workshopBusy}
            onClick={() => void openInWorkshop()}
          >
            {workshopBusy ? '…' : t('catalog.openInWorkshop')}
          </button>
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
    </div>
  );
}

export function StrategyCatalog() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetSymbol, setTargetSymbol] = useState<string>('');
  const [targetTimeframe, setTargetTimeframe] = useState<DslTimeframe | ''>('');
  const [availableSymbols, setAvailableSymbols] = useState<string[]>(QUICK_MULTI_ASSET_SYMBOLS);

  async function load() {
    try {
      const [catList, cryptoUni, stockUni] = await Promise.all([
        trpc.catalog.list.query(),
        trpc.market.scanUniverse.query().catch(() => null),
        trpc.market.stockSymbols.query().catch(() => null),
      ]);
      setEntries(catList);
      const merged = new Set<string>(QUICK_MULTI_ASSET_SYMBOLS);
      if (Array.isArray(cryptoUni)) {
        for (const s of cryptoUni) merged.add(s);
      }
      if (stockUni && Array.isArray(stockUni.rows)) {
        for (const s of stockUni.rows) merged.add(s.symbol);
      }
      setAvailableSymbols(Array.from(merged));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const symbolOptions = useMemo(() => availableSymbols, [availableSymbols]);

  return (
    <Panel stagger={2}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {t('catalog.hint')}
        </p>

        {/* Ziel-Asset & Timeframe-Wahl für alle Katalog-Vorlagen */}
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs shrink-0"
          style={{ borderColor: 'var(--color-line)', backgroundColor: 'rgba(255,255,255,0.02)' }}
        >
          <span className="font-medium" style={{ color: 'var(--color-mut)' }}>
            {t('catalog.targetAsset')}:
          </span>
          <select
            aria-label={t('catalog.targetAsset')}
            value={targetSymbol}
            onChange={(e) => setTargetSymbol(e.target.value)}
            className="rounded border bg-transparent px-2 py-1 text-xs"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-fg)' }}
          >
            <option value="" style={{ backgroundColor: '#0e131f' }}>
              {t('catalog.presetDefaultAsset')}
            </option>
            {symbolOptions.map((sym) => (
              <option key={sym} value={sym} style={{ backgroundColor: '#0e131f' }}>
                {sym}
              </option>
            ))}
          </select>

          <select
            aria-label={t('catalog.targetTimeframe')}
            value={targetTimeframe}
            onChange={(e) => setTargetTimeframe(e.target.value as DslTimeframe | '')}
            className="rounded border bg-transparent px-2 py-1 text-xs"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-fg)' }}
          >
            <option value="" style={{ backgroundColor: '#0e131f' }}>
              {t('catalog.presetDefaultTf')}
            </option>
            {DSL_TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf} style={{ backgroundColor: '#0e131f' }}>
                {tf}
              </option>
            ))}
          </select>

          {(targetSymbol || targetTimeframe) && (
            <button
              type="button"
              onClick={() => {
                setTargetSymbol('');
                setTargetTimeframe('');
              }}
              className="rounded border px-2 py-1 text-[11px]"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

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
                    <CatalogCard
                      key={e.slug}
                      entry={e}
                      targetSymbol={targetSymbol}
                      targetTimeframe={targetTimeframe}
                      onChanged={() => void load()}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
