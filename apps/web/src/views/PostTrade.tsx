import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ErrorBox, Loading, NotConnected, PageHeader, Panel, fmtNum } from '../components/ui.js';

/**
 * Post-Trade-Learning („/goal Ergänzung" §4/§13.8): sichtbare Auswertung
 * ABGESCHLOSSENER Trades — Trefferqualität, Score-Validität, Fehlerquellen,
 * Lehren. Alles deterministisch aus echten netto-Zahlen (kein LLM, kein Fake);
 * der Button stößt den idempotenten Lern-Lauf im Backend an (Mensch im Loop).
 */

type Data = Awaited<ReturnType<typeof trpc.intelligence.postTradeReviews.query>>;
type Row = Data['reviews'][number];
type HitQuality = 'excellent' | 'good' | 'acceptable' | 'poor' | 'loss';

const QUALITY_COLOR: Record<HitQuality, string> = {
  excellent: 'var(--color-pos)',
  good: 'var(--color-pos)',
  acceptable: 'var(--color-warn)',
  poor: 'var(--color-warn)',
  loss: 'var(--color-neg)',
};

function QualityPill({ quality, label }: { quality: HitQuality; label: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ borderColor: QUALITY_COLOR[quality], color: QUALITY_COLOR[quality] }}
    >
      {label}
    </span>
  );
}

/** Stabile Backend-Schlüssel → i18n; unbekannte Schlüssel werden roh gezeigt (ehrlich statt versteckt). */
function keyLabel(t: (k: string) => string, prefix: 'err' | 'lesson', key: string): string {
  const full = `posttrade.${prefix}_${key}`;
  const translated = t(full);
  return translated === full ? key : translated;
}

export function PostTrade({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    trpc.intelligence.postTradeReviews
      .query({ limit: 100 })
      .then(setData)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runLearning = async () => {
    setRunning(true);
    setRunNote(null);
    try {
      const res = await trpc.intelligence.runPostTradeLearning.mutate({});
      setRunNote({ kind: 'ok', text: t('posttrade.runResult', { evaluated: res.evaluated, created: res.created }) });
      load();
    } catch (err) {
      setRunNote({ kind: 'err', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setRunning(false);
    }
  };

  const agg = data?.aggregate ?? null;

  const runButton = (
    <button
      onClick={() => void runLearning()}
      disabled={running}
      className="rounded border px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
      style={{ borderColor: 'rgba(59,130,246,0.5)', color: 'var(--color-cyan)' }}
    >
      {running ? t('posttrade.running') : t('posttrade.runButton')}
    </button>
  );

  return (
    <div>
      {!embedded && <PageHeader title={t('posttrade.title')} subtitle={t('posttrade.subtitle')} />}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {runButton}
        {runNote && (
          <span className="text-sm" style={{ color: runNote.kind === 'ok' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {runNote.text}
          </span>
        )}
      </div>

      {loadError ? (
        <ErrorBox message={`${t('posttrade.loadError')} — ${loadError}`} />
      ) : data === null ? (
        <Loading />
      ) : data.reviews.length === 0 ? (
        <Panel>
          <NotConnected detail={t('posttrade.empty')} />
          <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('posttrade.emptyHint')}</p>
        </Panel>
      ) : (
        <>
          {/* Aggregierte Lern-Kennzahlen */}
          {agg && agg.count > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {(
                [
                  { label: t('posttrade.statCount'), value: String(agg.count) },
                  { label: t('posttrade.statWinRate'), value: `${fmtNum(agg.winRate * 100, 1)} %`, tone: agg.winRate >= 0.5 ? 'pos' : 'neg' },
                  { label: t('posttrade.statLosses'), value: String(agg.losses), tone: agg.losses > 0 ? 'neg' : undefined },
                  { label: t('posttrade.statAvgR'), value: agg.avgRMultiple !== null ? `${fmtNum(agg.avgRMultiple, 2)} R` : '—', tone: (agg.avgRMultiple ?? 0) >= 0 ? 'pos' : 'neg' },
                  { label: t('posttrade.statAvgValidity'), value: `${fmtNum(agg.avgScoreValidity * 100, 0)} %` },
                ] as { label: string; value: string; tone?: 'pos' | 'neg' }[]
              ).map((s) => (
                <div key={s.label} className="glass p-4">
                  <p className="label">{s.label}</p>
                  <p
                    className="num mt-1.5 text-xl font-semibold"
                    style={{ color: s.tone === 'pos' ? 'var(--color-pos)' : s.tone === 'neg' ? 'var(--color-neg)' : 'var(--color-ink)' }}
                  >
                    {s.value}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Häufigste Fehlerquellen */}
          {agg && agg.topErrorSources.length > 0 && (
            <Panel label={t('posttrade.topErrors')} className="mt-5">
              <div className="mt-3 flex flex-wrap gap-2">
                {agg.topErrorSources.map((e) => (
                  <span
                    key={e.key}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
                    style={{ borderColor: 'rgba(239,68,68,0.4)', color: 'var(--color-neg)' }}
                  >
                    {keyLabel(t, 'err', e.key)}
                    <span className="num font-semibold">×{e.count}</span>
                  </span>
                ))}
              </div>
            </Panel>
          )}

          {/* Review-Tabelle */}
          <Panel label={t('posttrade.tableTitle')} className="mt-5">
            <div className="overflow-x-auto">
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="label pb-2 pr-4">{t('posttrade.colTrade')}</th>
                    <th className="label pb-2 pr-4">{t('posttrade.colQuality')}</th>
                    <th className="label pb-2 pr-4 text-right">{t('posttrade.colValidity')}</th>
                    <th className="label pb-2 pr-4 text-right">R</th>
                    <th className="label pb-2 pr-4 text-right">{t('posttrade.colPnl')}</th>
                    <th className="label pb-2 pr-4">{t('posttrade.colFindings')}</th>
                    <th className="label pb-2 text-right">{t('posttrade.colDate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reviews.map((row: Row) => {
                    const r = row.review;
                    const errs = (r.errorSources as string[]) ?? [];
                    const lessons = (r.lessons as string[]) ?? [];
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {row.trade ? (
                            <>
                              <span className="num font-medium">{row.trade.symbol}</span>{' '}
                              <span style={{ color: row.trade.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                                {row.trade.direction === 'long' ? '▲ Long' : '▼ Short'}
                              </span>{' '}
                              <span className="label">{row.trade.mode}</span>
                            </>
                          ) : (
                            <span className="label">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <QualityPill quality={r.hitQuality as HitQuality} label={t(`posttrade.hitQuality_${r.hitQuality}`)} />
                        </td>
                        <td className="num py-2 pr-4 text-right">{fmtNum(Number(r.scoreValidity) * 100, 0)} %</td>
                        <td className="num py-2 pr-4 text-right" style={{ color: Number(r.rMultiple ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {r.rMultiple !== null ? fmtNum(Number(r.rMultiple), 2) : '—'}
                        </td>
                        <td className="num py-2 pr-4 text-right" style={{ color: Number(r.netPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {r.netPnl !== null ? `${fmtNum(Number(r.netPnl), 2)} $` : '—'}
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex max-w-md flex-wrap gap-1.5">
                            {errs.map((k) => (
                              <span key={`e-${k}`} className="rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: 'rgba(239,68,68,0.4)', color: 'var(--color-neg)' }}>
                                {keyLabel(t, 'err', k)}
                              </span>
                            ))}
                            {lessons.map((k) => (
                              <span key={`l-${k}`} className="rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: 'rgba(34,197,94,0.35)', color: 'var(--color-pos)' }}>
                                {keyLabel(t, 'lesson', k)}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="num py-2 text-right whitespace-nowrap">
                          {new Date((row.trade?.exitTs ?? r.createdAt) as string | Date).toLocaleDateString(locale)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('posttrade.hint')}</p>
          </Panel>
        </>
      )}
    </div>
  );
}
