import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../api.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { appLocale } from '../lib/locale.js';
import { EmptyState, ErrorBox, Loading, fmtNum } from './ui.js';

type StudyResponse = Awaited<ReturnType<typeof trpc.lab.signalStudies.query>>;
type VariantId = StudyResponse['analytics']['activeVariant'];
type StudyBucket = StudyResponse['analytics']['summary'];
type CurvePoint = StudyResponse['analytics']['usedCurve'][number];
type ScatterPoint = StudyResponse['analytics']['scatter'][number];
type EventCategoryFilter =
  | 'all'
  | 'any_event'
  | 'none'
  | 'inflation'
  | 'central_bank'
  | 'labor'
  | 'growth_pmi'
  | 'other_high_impact';
type SessionFilter = 'all' | 'asia' | 'london' | 'overlap' | 'newyork' | 'off';

const SESSION_LABELS: Record<string, string> = {
  asia: 'Asia',
  london: 'London',
  overlap: 'London/NY Overlap',
  newyork: 'New York',
  off: 'Off-Hours',
};

const EVENT_LABELS: Record<string, string> = {
  none: 'Kein Event',
  inflation: 'CPI / Inflation',
  central_bank: 'FOMC / Zinsen',
  labor: 'NFP / Arbeitsmarkt',
  growth_pmi: 'BIP / PMI',
  other_high_impact: 'Sonstiges High-Impact',
};

const EXIT_LABELS: Record<string, string> = {
  sl: 'Stop-Loss',
  tp1: 'TP1',
  tp2: 'TP2',
  tp3: 'TP3 (voll)',
  'tp1-be': 'TP1 + Break-Even',
  'tp2-be': 'TP2 + Break-Even',
  trail: 'Trailing-Stop',
};

const fmtR = (r: number | null) => (r === null ? '—' : `${r >= 0 ? '+' : ''}${fmtNum(r, 2)} R`);
const fmtPct = (v: number | null) => (v === null ? '—' : `${fmtNum(v * 100, 1)} %`);

function rColor(r: number | null): string {
  if (r === null) return 'var(--color-mut)';
  return r >= 0 ? 'var(--color-pos)' : 'var(--color-neg)';
}

/**
 * Autonome Signal-Studien im Labor (Welle 23):
 * Testet sowohl genutzte (gehandelte) als auch ungenutzte (verpasste/abgelaufene) Signale
 * gegen echte Folge-Kerzen in 5 Parameter-Varianten, aufgeschlüsselt nach Session,
 * Makro-Event (±2 h), Symbol und Strategie — mit 5 responsiven SVG-Grafiken.
 */
export function SignalStudiesPanel() {
  const [variant, setVariant] = useState<VariantId>('baseline');
  const [usageGroup, setUsageGroup] = useState<'all' | 'used' | 'missed'>('all');
  const [session, setSession] = useState<SessionFilter>('all');
  const [eventCategory, setEventCategory] = useState<EventCategoryFilter>('all');
  const [symbol, setSymbol] = useState<string>('all');
  const [timeframe, setTimeframe] = useState<string>('all');
  const [direction, setDirection] = useState<'all' | 'long' | 'short'>('all');
  const [strategySlug, setStrategySlug] = useState<string>('all');
  const [days, setDays] = useState<number>(0);

  const [data, setData] = useState<StudyResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [running, setRunning] = useState<boolean>(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await trpc.lab.signalStudies.query({
        variant,
        usageGroup,
        session,
        eventCategory,
        symbol,
        timeframe,
        direction,
        strategySlug,
        days,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signal-Studien konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [variant, usageGroup, session, eventCategory, symbol, timeframe, direction, strategySlug, days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function triggerBatch(forceReeval: boolean) {
    setRunning(true);
    setRunNote(null);
    setError(null);
    try {
      const res = await trpc.lab.runSignalStudies.mutate({ limit: 300, forceReeval });
      setRunNote(
        `Geprüft: ${res.signalsChecked} Signale · neu berechnet: ${res.signalsEvaluated} ` +
          `(${res.rowsUpserted} Varianten-Zeilen gespeichert, ${res.skippedClosed} bereits abgeschlossen übersprungen).`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Studien-Lauf fehlgeschlagen.');
    } finally {
      setRunning(false);
    }
  }

  const hasFilter =
    usageGroup !== 'all' ||
    session !== 'all' ||
    eventCategory !== 'all' ||
    symbol !== 'all' ||
    timeframe !== 'all' ||
    direction !== 'all' ||
    strategySlug !== 'all' ||
    days !== 0;

  function resetFilters() {
    setUsageGroup('all');
    setSession('all');
    setEventCategory('all');
    setSymbol('all');
    setTimeframe('all');
    setDirection('all');
    setStrategySlug('all');
    setDays(0);
  }

  const variantMeta = data?.variants.find((v) => v.id === variant);
  const analytics = data?.analytics;

  return (
    <div className="min-w-0 space-y-5 overflow-hidden">
      {/* ── Transparenz-Hinweis & Sofort-Auslöser ── */}
      <div className="glass min-w-0 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label">Autonomes Signal-Studien-Labor</span>
              <span
                className="rounded-full px-2 py-0.5 text-[11px]"
                style={{ background: 'rgba(6,182,212,0.14)', color: 'var(--color-cyan)' }}
              >
                Alle 30 Min. automatisch
              </span>
              {data?.lastEvaluatedAt && (
                <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                  Stand: {new Date(data.lastEvaluatedAt).toLocaleString(appLocale())}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              Testet <strong>benutzte</strong> und <strong>verpasste</strong> Signale automatisch ohne Look-Ahead auf echten
              Folge-Kerzen (inkl. Gebühren/Slippage) — über 5 Parameter-Varianten, Trading-Sessions und echte Makro-Events (±2 h).
              Hypothetische Labor-Studie, strikt getrennt von echten Trades.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              disabled={running}
              onClick={() => void triggerBatch(false)}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-cyan)] disabled:opacity-50"
              style={{ borderColor: 'rgba(6,182,212,0.5)', background: 'rgba(6,182,212,0.14)', color: 'var(--color-ink)' }}
            >
              {running ? '⏳ Rechnet…' : '🔄 Neue Signale studieren'}
            </button>
            <button
              type="button"
              disabled={running}
              onClick={() => void triggerBatch(true)}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              title="Alle bisherigen Signale komplett neu auswerten (z. B. nach neuen Kerzen)"
            >
              ♻️ Alles neu rechnen
            </button>
          </div>
        </div>
        {runNote && (
          <p className="mt-2 rounded border px-3 py-1.5 text-xs" style={{ borderColor: 'rgba(16,185,129,0.4)', color: 'var(--color-pos)' }}>
            {runNote}
          </p>
        )}
      </div>

      {/* ── Filter-Leiste ── */}
      <div className="glass min-w-0 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="label">Studien-Parameter &amp; Filter</span>
          {hasFilter && (
            <button
              type="button"
              onClick={resetFilters}
              className="text-xs underline"
              style={{ color: 'var(--color-cyan)' }}
            >
              Filter zurücksetzen
            </button>
          )}
        </div>

        {/* Varianten-Pills */}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {(data?.variants ?? []).map((v) => {
            const active = v.id === variant;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setVariant(v.id)}
                title={v.description}
                className="rounded-[0.625rem] border px-2.5 py-1 text-xs transition-colors"
                style={
                  active
                    ? { borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.18)', color: 'var(--color-ink)' }
                    : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                }
              >
                {v.label}
              </button>
            );
          })}
        </div>
        {variantMeta && (
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            Aktive Variante: <span style={{ color: 'var(--color-ink)' }}>{variantMeta.description}</span>
          </p>
        )}

        {/* Kontext-Filter */}
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8">
          <SelectField
            label="Nutzung"
            value={usageGroup}
            onChange={(v) => setUsageGroup(v as 'all' | 'used' | 'missed')}
            options={[
              ['all', 'Alle Signale'],
              ['used', 'Nur genutzte'],
              ['missed', 'Nur verpasste'],
            ]}
          />
          <SelectField
            label="Session"
            value={session}
            onChange={(v) => setSession(v as SessionFilter)}
            options={[
              ['all', 'Alle Sessions'],
              ['asia', 'Asia'],
              ['london', 'London'],
              ['overlap', 'Overlap (LDN/NY)'],
              ['newyork', 'New York'],
              ['off', 'Off-Hours'],
            ]}
          />
          <SelectField
            label="Makro-Event (±2 h)"
            value={eventCategory}
            onChange={(v) => setEventCategory(v as EventCategoryFilter)}
            options={[
              ['all', 'Alle'],
              ['any_event', 'Nur bei Event (±2 h)'],
              ['none', 'Nur ohne Event'],
              ['inflation', 'CPI / Inflation'],
              ['central_bank', 'FOMC / Zinsen'],
              ['labor', 'NFP / Arbeitsmarkt'],
              ['growth_pmi', 'BIP / PMI'],
              ['other_high_impact', 'Sonstiges High-Impact'],
            ]}
          />
          <SelectField
            label="Asset"
            value={symbol}
            onChange={setSymbol}
            options={[['all', 'Alle Assets'], ...(data?.availableSymbols ?? []).map((s): [string, string] => [s, s])]}
          />
          <SelectField
            label="Timeframe"
            value={timeframe}
            onChange={setTimeframe}
            options={[['all', 'Alle TFs'], ...(data?.availableTimeframes ?? []).map((tf): [string, string] => [tf, tf])]}
          />
          <SelectField
            label="Richtung"
            value={direction}
            onChange={(v) => setDirection(v as 'all' | 'long' | 'short')}
            options={[
              ['all', 'Long & Short'],
              ['long', 'Nur Long'],
              ['short', 'Nur Short'],
            ]}
          />
          <SelectField
            label="Strategie"
            value={strategySlug}
            onChange={setStrategySlug}
            options={[['all', 'Alle Strategien'], ...(data?.availableStrategies ?? []).map((s): [string, string] => [s, s])]}
          />
          <SelectField
            label="Zeitraum"
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={[
              ['0', 'Gesamte Historie'],
              ['30', 'Letzte 30 Tage'],
              ['90', 'Letzte 90 Tage'],
              ['180', 'Letzte 180 Tage'],
              ['365', 'Letzte 365 Tage'],
            ]}
          />
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      {loading && !data && <Loading />}

      {analytics && analytics.summary.total === 0 && (
        <EmptyState
          text={
            hasFilter
              ? 'Für die aktuelle Filter-Kombination liegen noch keine ausgewerteten Signale vor. Filter zurücksetzen oder „Neue Signale studieren“ klicken.'
              : 'Sobald der Scanner Signale erzeugt hat, wertet das Labor sie hier automatisch gegen die Folge-Kerzen aus.'
          }
          actionLabel={hasFilter ? 'Filter zurücksetzen' : '🔄 Neue Signale studieren'}
          onAction={hasFilter ? resetFilters : () => void triggerBatch(false)}
        />
      )}

      {analytics && analytics.summary.total > 0 && (
        <>
          {/* ── KPI-Streifen: Gesamt · Genutzt · Verpasst ── */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <BucketSummaryCard
              title="Gesamt (gefiltert)"
              subtitle={`${analytics.summary.closed} abgeschl. · ${analytics.summary.open} offen · ${analytics.summary.noData} o. Kerzen`}
              accent="var(--color-violet)"
              bucket={analytics.summary}
            />
            <BucketSummaryCard
              title="Genutzte Signale"
              subtitle="Bestätigt, gefüllt oder geschlossen"
              accent="var(--color-cyan)"
              bucket={analytics.used}
            />
            <BucketSummaryCard
              title="Verpasste / Ungenutzte Signale"
              subtitle="Abgelaufen oder abgelehnt — Was wäre passiert?"
              accent="#f59e0b"
              bucket={analytics.missed}
            />
          </div>

          {/* ── Grafik 1: Kumulierte R-Kurve (Genutzt vs. Verpasst) ── */}
          <div className="glass min-w-0 overflow-hidden p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">1. Kumulierte R-Kurve: Genutzt vs. Verpasst</h3>
                <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                  Chronologische Entwicklung des Netto-R-Multiples je abgeschlossenem Signal (Variante: {variantMeta?.label ?? variant}).
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#06b6d4' }} />
                  Genutzt ({analytics.usedCurve.length})
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#f59e0b' }} />
                  Verpasst ({analytics.missedCurve.length})
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-3" style={{ background: '#a78bfa' }} />
                  Gesamt ({analytics.allCurve.length})
                </span>
              </div>
            </div>
            <div className="mt-3">
              <DualCumRChart
                used={analytics.usedCurve}
                missed={analytics.missedCurve}
                all={analytics.allCurve}
              />
            </div>
          </div>

          {/* ── Grafik 2: Studien-Parameter-Vergleich (alle 5 Varianten) ── */}
          <div className="glass min-w-0 overflow-hidden p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">2. Vergleich der 5 Studien-Parameter auf denselben Signalen</h3>
                <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                  Klick auf eine Variante schaltet alle Grafiken &amp; Tabellen auf diesen Parameter-Satz um.
                </p>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {analytics.byVariant.map((b) => {
                const meta = data?.variants.find((v) => v.id === b.key);
                const maxAbs = Math.max(1, ...analytics.byVariant.map((x) => Math.abs(x.sumR)));
                const pctWidth = Math.min(100, Math.round((Math.abs(b.sumR) / maxAbs) * 100));
                const active = b.key === variant;
                return (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setVariant(b.key as VariantId)}
                    className="w-full rounded-[0.625rem] border p-2.5 text-left transition-colors"
                    style={
                      active
                        ? { borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.1)' }
                        : { borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.28)' }
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-medium">
                        {meta?.label ?? b.key}
                        {b.lowSample && (
                          <span className="ml-2 text-[10px]" style={{ color: 'var(--color-warn)' }}>
                            ⚠ n={b.closed}
                          </span>
                        )}
                      </span>
                      <span className="num flex flex-wrap gap-3">
                        <span style={{ color: rColor(b.closed ? b.sumR : null) }}>Σ {fmtR(b.closed ? b.sumR : null)}</span>
                        <span style={{ color: rColor(b.expectancyR) }}>Ø {fmtR(b.expectancyR)}</span>
                        <span style={{ color: 'var(--color-mut)' }}>WR {fmtPct(b.winRate)}</span>
                        <span style={{ color: 'var(--color-mut)' }}>
                          PF {b.profitFactor === null ? '—' : fmtNum(b.profitFactor, 2)}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full" style={{ background: 'rgba(148,163,184,0.14)' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pctWidth}%`,
                          background: b.sumR >= 0 ? 'var(--color-pos)' : 'var(--color-neg)',
                        }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Grafik 3 & 4: Session-Performance + Makro-Event-Einfluss nebeneinander ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BucketBarPanel
              title="3. Performance nach Trading-Session"
              subtitle="Klick auf eine Session filtert die gesamte Ansicht."
              buckets={analytics.bySession}
              labels={SESSION_LABELS}
              activeKey={session === 'all' ? null : session}
              onSelect={(k) => setSession((prev) => (prev === k ? 'all' : (k as SessionFilter)))}
            />
            <BucketBarPanel
              title="4. Performance bei Makro-Events (±2 h)"
              subtitle="Abgeglichen gegen echte Kalender-Events (CPI, FOMC, NFP, BIP/PMI)."
              buckets={analytics.byEvent}
              labels={EVENT_LABELS}
              activeKey={eventCategory === 'all' || eventCategory === 'any_event' ? null : eventCategory}
              onSelect={(k) => setEventCategory((prev) => (prev === k ? 'all' : (k as EventCategoryFilter)))}
            />
          </div>

          {/* ── Grafik 5: MFE vs. MAE Scatter-Plot + Asset-/Strategie-Aufschlüsselung ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="glass min-w-0 overflow-hidden p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">5. MFE vs. MAE Scatter-Plot (in R)</h3>
                  <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                    X = maximaler Rücklauf gegen das Signal (MAE), Y = maximaler Gewinnlauf (MFE). Hohes MFE bei Verlusten zeigt zu enge Stops oder zu weite TPs.
                  </p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                <span>● Gefüllt = Genutzt</span>
                <span>○ Ring = Verpasst</span>
                <span style={{ color: 'var(--color-pos)' }}>Grün = Gewinn (&gt; 0 R)</span>
                <span style={{ color: 'var(--color-neg)' }}>Rot = Verlust (≤ 0 R)</span>
              </div>
              <div className="mt-3">
                <MfeMaeScatterChart points={analytics.scatter} />
              </div>
            </div>

            <div className="glass min-w-0 overflow-hidden p-4 space-y-4">
              <div>
                <h3 className="text-sm font-medium">Aufschlüsselung nach Asset &amp; Strategie</h3>
                <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                  Klick auf ein Asset oder eine Strategie setzt direkt den Filter.
                </p>
              </div>
              <MiniBreakdownList
                heading="Assets"
                buckets={analytics.bySymbol}
                activeKey={symbol === 'all' ? null : symbol}
                onSelect={(k) => setSymbol((prev) => (prev === k ? 'all' : k))}
              />
              <MiniBreakdownList
                heading="Strategien"
                buckets={analytics.byStrategy}
                activeKey={strategySlug === 'all' ? null : strategySlug}
                onSelect={(k) => setStrategySlug((prev) => (prev === k ? 'all' : k))}
              />
            </div>
          </div>

          {/* ── Detail-Tabelle der studierten Signale ── */}
          <div className="glass min-w-0 overflow-hidden p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">
                  Studierte Einzelsignale ({analytics.recentItems.length} angezeigt)
                </h3>
                <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                  Direkt-Link in den Chart öffnet das Asset mit genau diesem Timeframe zur visuellen Prüfung.
                </p>
              </div>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-xs">
                <thead>
                  <tr className="label" style={{ borderBottom: '1px solid var(--color-line)' }}>
                    <th className="py-2 pr-3 font-normal">Datum</th>
                    <th className="py-2 pr-3 font-normal">Asset</th>
                    <th className="py-2 pr-3 font-normal">Nutzung</th>
                    <th className="py-2 pr-3 font-normal">Session</th>
                    <th className="py-2 pr-3 font-normal">Event (±2 h)</th>
                    <th className="py-2 pr-3 text-right font-normal">Netto R</th>
                    <th className="py-2 pr-3 text-right font-normal">MFE / MAE</th>
                    <th className="py-2 pr-3 font-normal">Exit</th>
                    <th className="py-2 text-right font-normal">Chart</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {analytics.recentItems.map((item) => (
                    <tr key={item.signalId} style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                      <td className="py-2 pr-3 whitespace-nowrap" style={{ color: 'var(--color-mut)' }}>
                        {new Date(item.signalCreatedAt).toLocaleDateString(appLocale(), {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className="font-medium">{item.symbol}</span>{' '}
                        <span style={{ color: 'var(--color-mut)' }}>
                          {item.timeframe} · {item.direction === 'long' ? 'Long' : 'Short'}
                        </span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px]"
                          style={
                            item.usageGroup === 'used'
                              ? { background: 'rgba(6,182,212,0.16)', color: 'var(--color-cyan)' }
                              : { background: 'rgba(245,158,11,0.16)', color: '#fbbf24' }
                          }
                        >
                          {item.usageGroup === 'used' ? 'Genutzt' : 'Verpasst'}
                        </span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap" style={{ color: 'var(--color-mut)' }}>
                        {SESSION_LABELS[item.session] ?? item.session}
                      </td>
                      <td className="py-2 pr-3 max-w-[180px] truncate" title={item.eventTitle ?? undefined}>
                        {item.eventCategory === 'none' ? (
                          <span style={{ color: 'var(--color-mut)' }}>—</span>
                        ) : (
                          <span style={{ color: 'var(--color-warn)' }}>
                            {EVENT_LABELS[item.eventCategory] ?? item.eventCategory}
                            {item.eventDeltaMin !== null && ` (${item.eventDeltaMin >= 0 ? '+' : ''}${item.eventDeltaMin}m)`}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap font-medium" style={{ color: rColor(item.rMultiple) }}>
                        {item.studyStatus === 'no_data' ? 'k. Daten' : fmtR(item.rMultiple)}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap" style={{ color: 'var(--color-mut)' }}>
                        {item.mfeR === null || item.maeR === null
                          ? '—'
                          : `+${fmtNum(item.mfeR, 1)} / -${fmtNum(Math.abs(item.maeR), 1)}`}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap" style={{ color: 'var(--color-mut)' }}>
                        {item.studyStatus === 'open'
                          ? 'Noch offen'
                          : item.studyStatus === 'no_data'
                            ? '—'
                            : (item.exitReason ? (EXIT_LABELS[item.exitReason] ?? item.exitReason) : '—')}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <a
                          href={buildChartUrl(item.symbol, item.timeframe, item.venue)}
                          className="rounded border px-2 py-0.5 text-[11px] transition-colors hover:border-[var(--color-cyan)]"
                          style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
                        >
                          Chart ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="block min-w-0">
      <span className="label block truncate">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-[0.5rem] border bg-transparent px-2 py-1.5 text-xs"
        style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)', backgroundColor: 'rgba(15,23,42,0.7)' }}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v} style={{ background: '#0f172a', color: '#e2e8f0' }}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function BucketSummaryCard({
  title,
  subtitle,
  accent,
  bucket,
}: {
  title: string;
  subtitle: string;
  accent: string;
  bucket: StudyBucket;
}) {
  return (
    <div className="glass min-w-0 p-4" style={{ borderTop: `2px solid ${accent}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {subtitle}
          </p>
        </div>
        {bucket.lowSample && bucket.total > 0 && (
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
            style={{ background: 'rgba(245,158,11,0.16)', color: 'var(--color-warn)' }}
            title="Weniger als 10 abgeschlossene Signale — statistisch noch nicht belastbar."
          >
            ⚠ n={bucket.closed}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5 text-xs">
        <div>
          <span className="label block">Summe R</span>
          <span className="num text-base font-semibold" style={{ color: rColor(bucket.closed > 0 ? bucket.sumR : null) }}>
            {bucket.closed > 0 ? fmtR(bucket.sumR) : '—'}
          </span>
        </div>
        <div>
          <span className="label block">Ø Erwartung</span>
          <span className="num text-base font-semibold" style={{ color: rColor(bucket.expectancyR) }}>
            {fmtR(bucket.expectancyR)}
          </span>
        </div>
        <div>
          <span className="label block">Trefferquote</span>
          <span className="num text-sm">
            {fmtPct(bucket.winRate)}{' '}
            <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
              ({bucket.wins}W / {bucket.losses}L)
            </span>
          </span>
        </div>
        <div>
          <span className="label block">PF · Ø MFE / MAE</span>
          <span className="num text-sm">
            {bucket.profitFactor === null ? '—' : fmtNum(bucket.profitFactor, 2)}
            <span className="ml-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
              {bucket.avgMfeR === null ? '' : `+${fmtNum(bucket.avgMfeR, 1)} / -${fmtNum(Math.abs(bucket.avgMaeR ?? 0), 1)}R`}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Dual-Line SVG für kumulierte R-Kurve: Genutzt vs. Verpasst + Gesamt. */
function DualCumRChart({
  used,
  missed,
  all,
}: {
  used: CurvePoint[];
  missed: CurvePoint[];
  all: CurvePoint[];
}) {
  const series = [used, missed, all].filter((s) => s.length > 0);
  if (series.length === 0) {
    return (
      <p className="py-6 text-center text-xs" style={{ color: 'var(--color-mut)' }}>
        Noch keine abgeschlossenen Signale für die R-Kurve.
      </p>
    );
  }

  const W = 720;
  const H = 220;
  const padL = 46;
  const padR = 16;
  const padT = 16;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const allVals = [0, ...used.map((p) => p.cumR), ...missed.map((p) => p.cumR), ...all.map((p) => p.cumR)];
  const minY = Math.min(...allVals);
  const maxY = Math.max(...allVals);
  const spanY = Math.max(1, maxY - minY);
  const maxLen = Math.max(1, used.length, missed.length, all.length);

  const toX = (idx: number, len: number) => {
    const denom = Math.max(1, len);
    return padL + (idx / denom) * plotW;
  };
  const toY = (v: number) => padT + ((maxY - v) / spanY) * plotH;

  const pathFor = (pts: CurvePoint[]) => {
    if (pts.length === 0) return '';
    const coords = [
      `M ${toX(0, maxLen).toFixed(1)} ${toY(0).toFixed(1)}`,
      ...pts.map((p, i) => `L ${toX(i + 1, maxLen).toFixed(1)} ${toY(p.cumR).toFixed(1)}`),
    ];
    return coords.join(' ');
  };

  const zeroY = toY(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Kumulierte R-Kurve Genutzt vs. Verpasst">
      {/* Hilfslinien */}
      {[minY, 0, maxY].map((val, idx) => {
        const y = toY(val);
        return (
          <g key={idx}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y}
              y2={y}
              stroke={val === 0 ? 'rgba(148,163,184,0.45)' : 'rgba(148,163,184,0.14)'}
              strokeDasharray={val === 0 ? '4 4' : undefined}
            />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
              {val >= 0 ? `+${val.toFixed(1)}R` : `${val.toFixed(1)}R`}
            </text>
          </g>
        );
      })}

      {/* Nulllinie markant */}
      <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="rgba(148,163,184,0.35)" strokeDasharray="3 3" />

      {/* Gesamt-Kurve (gestrichelt) */}
      {all.length > 0 && (
        <path d={pathFor(all)} fill="none" stroke="#a78bfa" strokeWidth="1.6" strokeDasharray="5 4" opacity="0.85" />
      )}

      {/* Verpasste Signale (Amber) */}
      {missed.length > 0 && (
        <path d={pathFor(missed)} fill="none" stroke="#f59e0b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      )}

      {/* Genutzte Signale (Cyan) */}
      {used.length > 0 && (
        <path d={pathFor(used)} fill="none" stroke="#06b6d4" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      )}

      {/* Endpunkte */}
      {missed.length > 0 && (
        <circle cx={toX(missed.length, maxLen)} cy={toY(missed[missed.length - 1]!.cumR)} r="3.5" fill="#f59e0b">
          <title>Verpasst gesamt: {fmtR(missed[missed.length - 1]!.cumR)}</title>
        </circle>
      )}
      {used.length > 0 && (
        <circle cx={toX(used.length, maxLen)} cy={toY(used[used.length - 1]!.cumR)} r="3.5" fill="#06b6d4">
          <title>Genutzt gesamt: {fmtR(used[used.length - 1]!.cumR)}</title>
        </circle>
      )}

      {/* X-Achsen-Hinweis */}
      <text x={padL} y={H - 6} fontSize="10" fill="#94a3b8">
        Signal #1
      </text>
      <text x={W - padR} y={H - 6} textAnchor="end" fontSize="10" fill="#94a3b8">
        Signal #{maxLen} (chronologisch)
      </text>
    </svg>
  );
}

/** Horizontales Balkendiagramm für Sessions oder Makro-Events. */
function BucketBarPanel({
  title,
  subtitle,
  buckets,
  labels,
  activeKey,
  onSelect,
}: {
  title: string;
  subtitle: string;
  buckets: StudyBucket[];
  labels: Record<string, string>;
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const maxAbs = Math.max(1, ...buckets.map((b) => Math.abs(b.sumR)));
  return (
    <div className="glass min-w-0 overflow-hidden p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
        {subtitle}
      </p>
      {buckets.length === 0 ? (
        <p className="py-6 text-center text-xs" style={{ color: 'var(--color-mut)' }}>
          Keine Daten in dieser Kategorie.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {buckets.map((b) => {
            const pct = Math.min(100, Math.round((Math.abs(b.sumR) / maxAbs) * 100));
            const isActive = activeKey === b.key;
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => onSelect(b.key)}
                className="w-full rounded-[0.5rem] border p-2 text-left transition-colors"
                style={
                  isActive
                    ? { borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.12)' }
                    : { borderColor: 'rgba(148,163,184,0.14)', background: 'rgba(15,23,42,0.22)' }
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium">
                    {labels[b.key] ?? b.key}
                    <span className="ml-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                      (n={b.closed}/{b.total})
                    </span>
                    {b.lowSample && (
                      <span className="ml-1 text-[10px]" style={{ color: 'var(--color-warn)' }}>
                        ⚠
                      </span>
                    )}
                  </span>
                  <span className="num flex gap-2.5">
                    <span style={{ color: rColor(b.closed ? b.sumR : null) }}>{fmtR(b.closed ? b.sumR : null)}</span>
                    <span style={{ color: 'var(--color-mut)' }}>WR {fmtPct(b.winRate)}</span>
                  </span>
                </div>
                {/* Zweigeteilter Balken um die Mitte */}
                <div className="mt-1.5 grid grid-cols-2 gap-0.5">
                  <div className="flex justify-end overflow-hidden rounded-l-full" style={{ background: 'rgba(148,163,184,0.12)', height: 7 }}>
                    {b.sumR < 0 && <div style={{ width: `${pct}%`, background: 'var(--color-neg)', height: '100%' }} />}
                  </div>
                  <div className="flex justify-start overflow-hidden rounded-r-full" style={{ background: 'rgba(148,163,184,0.12)', height: 7 }}>
                    {b.sumR > 0 && <div style={{ width: `${pct}%`, background: 'var(--color-pos)', height: '100%' }} />}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** MFE vs. MAE Scatter-Plot (X = |MAE| in R, Y = MFE in R). */
function MfeMaeScatterChart({ points }: { points: ScatterPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-6 text-center text-xs" style={{ color: 'var(--color-mut)' }}>
        Noch keine abgeschlossenen Signale mit MFE/MAE-Daten.
      </p>
    );
  }
  const W = 440;
  const H = 220;
  const padL = 40;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxMae = Math.max(1.5, ...points.map((p) => Math.abs(p.maeR)));
  const maxMfe = Math.max(2, ...points.map((p) => Math.max(0, p.mfeR)));

  const toX = (mae: number) => padL + (Math.abs(mae) / maxMae) * plotW;
  const toY = (mfe: number) => padT + ((maxMfe - Math.max(0, mfe)) / maxMfe) * plotH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="MFE vs MAE Scatter Plot">
      {/* Achsen */}
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="rgba(148,163,184,0.35)" />
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(148,163,184,0.35)" />

      {/* 1R Referenzlinien */}
      {1 <= maxMae && (
        <line x1={toX(1)} x2={toX(1)} y1={padT} y2={H - padB} stroke="rgba(239,68,68,0.28)" strokeDasharray="3 3" />
      )}
      {1 <= maxMfe && (
        <line x1={padL} x2={W - padR} y1={toY(1)} y2={toY(1)} stroke="rgba(16,185,129,0.28)" strokeDasharray="3 3" />
      )}

      {/* Punkte */}
      {points.map((p) => {
        const win = p.rMultiple > 0;
        const color = win ? '#10b981' : '#ef4444';
        const used = p.usageGroup === 'used';
        return (
          <circle
            key={p.signalId}
            cx={toX(p.maeR)}
            cy={toY(p.mfeR)}
            r={used ? 4.2 : 3.6}
            fill={used ? color : 'transparent'}
            stroke={color}
            strokeWidth={used ? 1 : 1.7}
            opacity="0.85"
          >
            <title>
              {p.symbol} ({p.timeframe} {p.direction}) · {used ? 'Genutzt' : 'Verpasst'} · Netto {fmtR(p.rMultiple)} · MFE +{fmtNum(p.mfeR, 2)}R · MAE -{fmtNum(Math.abs(p.maeR), 2)}R
            </title>
          </circle>
        );
      })}

      {/* Labels */}
      <text x={padL - 5} y={padT + 8} textAnchor="end" fontSize="9.5" fill="#94a3b8">
        +{maxMfe.toFixed(1)}R
      </text>
      <text x={padL - 5} y={H - padB} textAnchor="end" fontSize="9.5" fill="#94a3b8">
        0
      </text>
      <text x={W - padR} y={H - 8} textAnchor="end" fontSize="9.5" fill="#94a3b8">
        MAE bis -{maxMae.toFixed(1)}R →
      </text>
      <text x={padL + 4} y={padT + 9} fontSize="9.5" fill="#94a3b8">
        ↑ MFE (Gewinn-Potenzial)
      </text>
    </svg>
  );
}

function MiniBreakdownList({
  heading,
  buckets,
  activeKey,
  onSelect,
}: {
  heading: string;
  buckets: StudyBucket[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  if (buckets.length === 0) return null;
  return (
    <div>
      <p className="label mb-1.5">{heading}</p>
      <div className="flex flex-wrap gap-1.5">
        {buckets.slice(0, 14).map((b) => {
          const active = activeKey === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => onSelect(b.key)}
              className="num rounded-full border px-2.5 py-1 text-[11px] transition-colors"
              style={
                active
                  ? { borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.16)', color: 'var(--color-ink)' }
                  : { borderColor: 'var(--color-line)', color: 'var(--color-ink)' }
              }
            >
              {b.key}{' '}
              <span style={{ color: rColor(b.closed ? b.sumR : null) }}>{fmtR(b.closed ? b.sumR : null)}</span>{' '}
              <span style={{ color: 'var(--color-mut)' }}>({b.closed})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
