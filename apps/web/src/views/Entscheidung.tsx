import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ErrorBox, Loading, NotConnected, PageHeader, Panel, fmtNum } from '../components/ui.js';

/**
 * KI-Trading-Intelligence — Entscheidungsgrundlagen („/goal Ergänzung" §5–§7,
 * §10–§12): CPI-Event-Regime, COT-Positionierung und Buffett-Bewertungsfilter
 * als sichtbare Entscheidungskategorien. NUR echte Daten; jede Quelle fällt
 * einzeln ehrlich auf „nicht verbunden" zurück. BTC/USDT ist ausdrücklich nur
 * der markierte Beispielmarkt — die Logik ist multi-asset-übertragbar.
 */

type CpiSnapshot = {
  phase: 'none' | 'pre_event' | 'release_window' | 'post_event' | 'confirmed_reaction';
  surprise: 'higher' | 'lower' | 'inline' | null;
  inflationYoY: number | null;
  eventAt: string | null;
  connected: boolean;
};

type CotEntry = {
  market: { code: string; label: string; appSymbols: string[] };
  positioning: {
    status: 'not_applicable' | 'neutral' | 'crowded_long' | 'crowded_short' | 'contrarian_alert';
    netNonComm: number;
    netRatio: number;
    percentile: number;
    weekChange: number;
  };
  reportDate: string | null;
  weeks: number;
};

type BuffettSnapshot = {
  status: 'not_applicable' | 'neutral' | 'elevated' | 'extreme';
  ratio: number | null;
  percentile: number;
  ts: string | null;
  connected: boolean;
};

type Overview = { cpi: CpiSnapshot; cot: CotEntry[]; buffett: BuffettSnapshot };

const PHASE_COLOR: Record<CpiSnapshot['phase'], string> = {
  none: 'var(--color-mut)',
  pre_event: 'var(--color-warn)',
  release_window: 'var(--color-neg)',
  post_event: 'var(--color-warn)',
  confirmed_reaction: 'var(--color-cyan)',
};

const COT_COLOR: Record<CotEntry['positioning']['status'], string> = {
  not_applicable: 'var(--color-mut)',
  neutral: 'var(--color-mut)',
  crowded_long: 'var(--color-warn)',
  crowded_short: 'var(--color-warn)',
  contrarian_alert: 'var(--color-neg)',
};

const BUFFETT_COLOR: Record<BuffettSnapshot['status'], string> = {
  not_applicable: 'var(--color-mut)',
  neutral: 'var(--color-pos)',
  elevated: 'var(--color-warn)',
  extreme: 'var(--color-neg)',
};

function StatusPill({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
      style={{ borderColor: color, color }}
    >
      {text}
    </span>
  );
}

function fmtWhen(iso: string | null, locale: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function Entscheidung({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  async function load() {
    try {
      const [cpi, cot, buffett] = await Promise.all([
        trpc.intelligence.cpiStatus.query(),
        trpc.intelligence.cotSnapshot.query({}),
        trpc.intelligence.buffettStatus.query(),
      ]);
      setData({ cpi, cot, buffett } as Overview);
      setLoadError(null);
    } catch (err) {
      // Fehler ≠ „keine Daten": ehrlich anzeigen statt leerem Zustand.
      setData(null);
      setLoadError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg(null);
    // Jede Quelle einzeln — eine tote Quelle blockiert die anderen nicht.
    const parts: string[] = [];
    const errors: string[] = [];
    try {
      const cpi = await trpc.intelligence.syncCpi.mutate();
      parts.push(t('intel.syncResultCpi', { n: cpi.points }));
    } catch (err) {
      errors.push(`CPI: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const cot = await trpc.intelligence.syncCot.mutate();
      parts.push(t('intel.syncResultCot', { n: cot.rows }));
      errors.push(...cot.errors);
    } catch (err) {
      errors.push(`COT: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const buf = await trpc.intelligence.syncBuffett.mutate();
      if (buf.ratio !== null) parts.push(t('intel.syncResultBuffett'));
      else errors.push(t('intel.syncBuffettNoData'));
    } catch (err) {
      errors.push(`Buffett: ${err instanceof Error ? err.message : String(err)}`);
    }
    setSyncMsg(errors.length > 0 ? `${parts.join(' · ')} — ${errors.join(' | ')}` : parts.join(' · '));
    await load();
    setSyncing(false);
  }

  const locale = i18n.language;

  return (
    <div>
      {!embedded && <PageHeader title={t('intel.title')} subtitle={t('intel.subtitle')} />}

      {loadError && <ErrorBox message={`${t('intel.loadError')}: ${loadError}`} />}
      {!data && !loadError && <Loading />}

      {data && (
        <>
          {/* Beispielmarkt-Hinweis (PDF §12) + manueller Sync */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('intel.exampleMarketNote')}
            </p>
            <button
              onClick={() => void syncNow()}
              disabled={syncing}
              className="btn-primary shrink-0 px-4 py-1.5 text-sm disabled:opacity-50"
            >
              {syncing ? t('intel.syncing') : t('intel.syncNow')}
            </button>
          </div>
          {syncMsg && (
            <p className="mb-5 text-sm" style={{ color: 'var(--color-mut)' }}>
              {syncMsg}
            </p>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            {/* CPI-Event-Regime (PDF §5) */}
            <Panel label={t('intel.cpiTitle')} stagger={1}>
              {!data.cpi.connected ? (
                <NotConnected detail={t('intel.cpiNotConnected')} />
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill text={t(`intel.cpiPhase_${data.cpi.phase}`)} color={PHASE_COLOR[data.cpi.phase]} />
                    {data.cpi.surprise && (
                      <StatusPill
                        text={t(`intel.cpiSurprise_${data.cpi.surprise}`)}
                        color={data.cpi.surprise === 'inline' ? 'var(--color-mut)' : 'var(--color-warn)'}
                      />
                    )}
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                    {t(`intel.cpiPhaseHint_${data.cpi.phase}`)}
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="label">{t('intel.cpiEventAt')}</p>
                      <p className="num mt-1">{fmtWhen(data.cpi.eventAt, locale)}</p>
                    </div>
                    <div>
                      <p className="label">{t('intel.cpiYoY')}</p>
                      <p className="num mt-1">
                        {data.cpi.inflationYoY !== null ? `${fmtNum(data.cpi.inflationYoY, 1)} %` : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </Panel>

            {/* Buffett-Bewertungsfilter (PDF §7) */}
            <Panel label={t('intel.buffettTitle')} stagger={2}>
              {!data.buffett.connected ? (
                <NotConnected detail={t('intel.buffettNotConnected')} />
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill text={t(`intel.buffettStatus_${data.buffett.status}`)} color={BUFFETT_COLOR[data.buffett.status]} />
                    <span className="num text-sm" style={{ color: 'var(--color-mut)' }}>
                      {t('intel.buffettPercentile', { n: Math.round(data.buffett.percentile * 100) })}
                    </span>
                  </div>
                  {/* Perzentil-Balken (selbstkalibrierend über die eigene Historie) */}
                  <div className="h-2 w-full max-w-sm overflow-hidden rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${Math.round(data.buffett.percentile * 100)}%`,
                        background: BUFFETT_COLOR[data.buffett.status],
                      }}
                    />
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                    {t('intel.buffettHint')}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                    {t('intel.buffettAsOf', { date: fmtDay(data.buffett.ts, locale) })}
                  </p>
                </div>
              )}
            </Panel>
          </div>

          {/* COT-Positionierung (PDF §6) */}
          <Panel label={t('intel.cotTitle')} stagger={3} className="mt-5">
            {data.cot.length === 0 || data.cot.every((c) => c.weeks === 0) ? (
              <NotConnected detail={t('intel.cotNotConnected')} />
            ) : (
              <>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                  {t('intel.cotHint')}
                </p>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th className="label pb-2 pr-4">{t('intel.cotMarket')}</th>
                        <th className="label pb-2 pr-4 text-right">{t('intel.cotNet')}</th>
                        <th className="label pb-2 pr-4 text-right">{t('intel.cotNetRatio')}</th>
                        <th className="label pb-2 pr-4 text-right">{t('intel.cotWeekChange')}</th>
                        <th className="label pb-2 pr-4 text-right">{t('intel.cotPercentile')}</th>
                        <th className="label pb-2 pr-4">{t('intel.cotStatus')}</th>
                        <th className="label pb-2 text-right">{t('intel.cotReportDate')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cot
                        .filter((c) => c.weeks > 0)
                        .map((c) => (
                          <tr key={c.market.code} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                            <td className="py-2 pr-4 font-medium">{t(`intel.cotMarket_${c.market.label}`)}</td>
                            <td className="num py-2 pr-4 text-right">{c.positioning.netNonComm.toLocaleString(locale)}</td>
                            <td
                              className="num py-2 pr-4 text-right"
                              style={{ color: c.positioning.netRatio >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
                            >
                              {fmtNum(c.positioning.netRatio * 100, 1)} %
                            </td>
                            <td className="num py-2 pr-4 text-right">
                              {c.positioning.weekChange >= 0 ? '+' : ''}
                              {fmtNum(c.positioning.weekChange * 100, 1)} pp
                            </td>
                            <td className="num py-2 pr-4 text-right">{Math.round(c.positioning.percentile * 100)}</td>
                            <td className="py-2 pr-4">
                              <StatusPill text={t(`intel.cotStatus_${c.positioning.status}`)} color={COT_COLOR[c.positioning.status]} />
                            </td>
                            <td className="num py-2 text-right">{fmtDay(c.reportDate, locale)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Panel>

          {/* Entscheidungslogik sichtbar machen (PDF §10/§13.7): Hedge-Modi + No-Trade als gültige Kategorie */}
          <Panel label={t('intel.logicTitle')} stagger={4} className="mt-5">
            <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('intel.logicHint')}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(['no_hedge', 'reduce', 'partial_hedge', 'full_hedge', 'flat', 'flip_warning'] as const).map((m) => (
                <div key={m} className="rounded-[0.625rem] border p-3" style={{ borderColor: 'rgba(99,140,255,0.12)' }}>
                  <p className="text-sm font-medium">{t(`intel.hedge_${m}`)}</p>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                    {t(`intel.hedgeHint_${m}`)}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm leading-relaxed" style={{ color: 'var(--color-violet)' }}>
              {t('intel.noTradeNote')}
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
