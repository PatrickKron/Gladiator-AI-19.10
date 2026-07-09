import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BB_MULT_MAX,
  BB_MULT_MIN,
  clampFloat,
  clampInt,
  defaultIndicatorConfig,
  MA_COLORS,
  MAX_MAS,
  PERIOD_MAX,
  PERIOD_MIN,
  type IndicatorConfig,
} from '../lib/indicators.js';

/**
 * Indikator-Panel am Voll-Chart (Patricks Wunsch: „eigene Indikatoren anwenden
 * und eigene Pine Scripts anzeigen lassen").
 *
 * - EMA/SMA mit frei wählbaren Perioden (mehrere gleichzeitig), RSI, MACD,
 *   Bollinger — jeweils an/aus + Parameter. Persistenz übernimmt der Aufrufer
 *   (AssetChart) pro Symbol in localStorage.
 * - Strategie-Marker: Signale registrierter Pine-/DSL-Strategien als
 *   Entry-Marker. EHRLICH: ein direktes Pine-Rendering existiert nicht —
 *   der Weg läuft über Strategien → Import, das steht auch so im Panel.
 *
 * WARUM Zahlenfelder mit lokalem Entwurf + Commit bei Blur/Enter: jede
 * Konfigurationsänderung baut den Chart komplett neu — pro Tastendruck wäre
 * das träge und würde halbe Eingaben („1" auf dem Weg zu „150") verrechnen.
 */

export type PineStrategy = { slug: string; name: string; kind: 'pine' | 'dsl' };

function NumField({
  value,
  min,
  max,
  float = false,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  /** true → Dezimalwerte erlaubt (Bollinger-Faktor), sonst Ganzzahl. */
  float?: boolean;
  onCommit: (n: number) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(String(value));
  // Externe Änderung (z. B. Zurücksetzen, Symbolwechsel) → Entwurf nachziehen.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const raw = draft.replace(',', '.');
    const n = float ? clampFloat(raw, min, max, value) : clampInt(raw, min, max, value);
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      inputMode="decimal"
      aria-label={ariaLabel}
      className="field num w-16 px-2 py-1 text-center text-xs"
    />
  );
}

/** Beschriftung links neben einem Parameterfeld — klein, aber lesbar (Patrick: Klarheit). */
function FieldLabel({ text }: { text: string }) {
  return (
    <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
      {text}
    </span>
  );
}

export function ChartIndicatorPanel({
  config,
  onChange,
  strategies,
  strategySignalCount,
}: {
  config: IndicatorConfig;
  onChange: (next: IndicatorConfig) => void;
  /** null = lädt noch · 'error' = ehrlicher Fehlerzustand · sonst die Pine-/DSL-Liste. */
  strategies: PineStrategy[] | 'error' | null;
  /** Anzahl geladener Signale der gewählten Strategien für dieses Symbol (Ehrlichkeit). */
  strategySignalCount: number;
}) {
  const { t } = useTranslation();

  const updateMa = (i: number, next: { kind: 'ema' | 'sma'; period: number }) => {
    onChange({ ...config, mas: config.mas.map((m, j) => (j === i ? next : m)) });
  };
  const removeMa = (i: number) => {
    onChange({ ...config, mas: config.mas.filter((_, j) => j !== i) });
  };
  const addMa = () => {
    if (config.mas.length >= MAX_MAS) return;
    onChange({ ...config, mas: [...config.mas, { kind: 'ema', period: 21 }] });
  };
  const toggleSlug = (slug: string) => {
    const has = config.strategySlugs.includes(slug);
    onChange({
      ...config,
      strategySlugs: has ? config.strategySlugs.filter((s) => s !== slug) : [...config.strategySlugs, slug],
    });
  };

  const checkbox = (checked: boolean, onToggle: () => void, label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: checked ? 'var(--color-ink)' : 'var(--color-mut)' }}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="accent-[#8b5cf6]" />
      <span className="font-medium">{label}</span>
    </label>
  );

  return (
    <div className="rounded border p-3" style={{ borderColor: 'rgba(139,92,246,0.35)', background: 'rgba(4,6,20,0.45)' }}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{t('chart.ind.title')}</p>
          <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('chart.ind.subtitle')}
          </p>
        </div>
        <button
          onClick={() => onChange(defaultIndicatorConfig())}
          className="rounded border px-2 py-0.5 text-[11px] transition-colors"
          style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
        >
          {t('chart.ind.reset')}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* ── Gleitende Durchschnitte (mehrere, frei parametrierbar) ── */}
        <div>
          <p className="label mb-1.5">{t('chart.ind.maTitle')}</p>
          <div className="flex flex-col gap-1.5">
            {config.mas.map((m, i) => (
              <div key={`${i}-${m.kind}`} className="flex flex-wrap items-center gap-2">
                {/* Farbpunkt = Linienfarbe im Chart — so findet Patrick seine Linie wieder */}
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: MA_COLORS[i % MA_COLORS.length]! }} />
                <select
                  value={m.kind}
                  onChange={(e) => updateMa(i, { ...m, kind: e.target.value as 'ema' | 'sma' })}
                  className="field cursor-pointer px-2 py-1 text-xs"
                  aria-label={t('chart.ind.maTitle')}
                >
                  <option value="ema">EMA</option>
                  <option value="sma">SMA</option>
                </select>
                <FieldLabel text={t('chart.ind.period')} />
                <NumField value={m.period} min={PERIOD_MIN} max={PERIOD_MAX} onCommit={(n) => updateMa(i, { ...m, period: n })} ariaLabel={`${m.kind.toUpperCase()} ${t('chart.ind.period')}`} />
                <button
                  onClick={() => removeMa(i)}
                  title={t('chart.ind.remove')}
                  aria-label={t('chart.ind.remove')}
                  className="px-1 text-xs"
                  style={{ color: 'var(--color-neg)' }}
                >
                  ✕
                </button>
              </div>
            ))}
            {config.mas.length < MAX_MAS ? (
              <button
                onClick={addMa}
                className="self-start rounded border px-2 py-1 text-xs transition-colors"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
              >
                {t('chart.ind.maAdd')}
              </button>
            ) : (
              <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                {t('chart.ind.maLimit', { n: MAX_MAS })}
              </p>
            )}
          </div>

          {/* ── Oszillatoren & Bänder ── */}
          <p className="label mb-1.5 mt-4">{t('chart.ind.oscTitle')}</p>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {checkbox(config.rsi.on, () => onChange({ ...config, rsi: { ...config.rsi, on: !config.rsi.on } }), 'RSI')}
              <FieldLabel text={t('chart.ind.period')} />
              <NumField value={config.rsi.period} min={PERIOD_MIN} max={100} onCommit={(n) => onChange({ ...config, rsi: { ...config.rsi, period: n } })} ariaLabel={`RSI ${t('chart.ind.period')}`} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {checkbox(config.macd.on, () => onChange({ ...config, macd: { ...config.macd, on: !config.macd.on } }), 'MACD')}
              <FieldLabel text={t('chart.ind.fast')} />
              <NumField
                value={config.macd.fast}
                min={PERIOD_MIN}
                max={Math.min(100, config.macd.slow - 1)}
                onCommit={(n) => onChange({ ...config, macd: { ...config.macd, fast: n } })}
                ariaLabel={`MACD ${t('chart.ind.fast')}`}
              />
              <FieldLabel text={t('chart.ind.slow')} />
              <NumField
                value={config.macd.slow}
                min={config.macd.fast + 1}
                max={200}
                onCommit={(n) => onChange({ ...config, macd: { ...config.macd, slow: n } })}
                ariaLabel={`MACD ${t('chart.ind.slow')}`}
              />
              <FieldLabel text={t('chart.ind.signal')} />
              <NumField
                value={config.macd.signal}
                min={PERIOD_MIN}
                max={100}
                onCommit={(n) => onChange({ ...config, macd: { ...config.macd, signal: n } })}
                ariaLabel={`MACD ${t('chart.ind.signal')}`}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {checkbox(config.bollinger.on, () => onChange({ ...config, bollinger: { ...config.bollinger, on: !config.bollinger.on } }), 'Bollinger')}
              <FieldLabel text={t('chart.ind.period')} />
              <NumField
                value={config.bollinger.period}
                min={PERIOD_MIN}
                max={PERIOD_MAX}
                onCommit={(n) => onChange({ ...config, bollinger: { ...config.bollinger, period: n } })}
                ariaLabel={`Bollinger ${t('chart.ind.period')}`}
              />
              <FieldLabel text={t('chart.ind.mult')} />
              <NumField
                value={config.bollinger.mult}
                min={BB_MULT_MIN}
                max={BB_MULT_MAX}
                float
                onCommit={(n) => onChange({ ...config, bollinger: { ...config.bollinger, mult: n } })}
                ariaLabel={`Bollinger ${t('chart.ind.mult')}`}
              />
            </div>
          </div>
        </div>

        {/* ── Strategie-Marker (Pine & DSL) — ehrlich, kein Pine-Renderer ── */}
        <div>
          <p className="label mb-1.5">{t('chart.ind.strategyTitle')}</p>
          <p className="mb-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('chart.ind.pineHint')}
          </p>
          {strategies === null && (
            <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('chart.ind.strategiesLoading')}
            </p>
          )}
          {strategies === 'error' && (
            <p className="text-xs" style={{ color: 'var(--color-neg)' }}>
              {t('chart.ind.strategiesError')}
            </p>
          )}
          {Array.isArray(strategies) && strategies.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('chart.ind.noStrategies')}{' '}
              <a href="#/strategien" className="underline" style={{ color: 'var(--color-cyan)' }}>
                {t('chart.ind.openStrategies')}
              </a>
            </p>
          )}
          {Array.isArray(strategies) && strategies.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {strategies.map((s) => (
                <label key={s.slug} className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={config.strategySlugs.includes(s.slug)}
                    onChange={() => toggleSlug(s.slug)}
                    className="mt-0.5 accent-[#e14ecf]"
                  />
                  <span style={{ color: config.strategySlugs.includes(s.slug) ? 'var(--color-ink)' : 'var(--color-mut)' }}>
                    {s.name} <span className="num" style={{ color: 'var(--color-mut)' }}>({s.slug})</span>{' '}
                    <span
                      className="rounded border px-1 text-[10px] uppercase"
                      style={{ borderColor: 'var(--color-line)', color: s.kind === 'pine' ? 'var(--color-magenta)' : 'var(--color-violet)' }}
                    >
                      {s.kind}
                    </span>
                  </span>
                </label>
              ))}
              {/* Nur Slugs zählen, die es noch gibt — sonst warnt ein verwaister
                  gespeicherter Slug (gelöschte Strategie) für immer. */}
              {config.strategySlugs.some((slug) => strategies.some((s) => s.slug === slug)) && (
                <p className="mt-1 text-[11px]" style={{ color: strategySignalCount > 0 ? 'var(--color-mut)' : 'var(--color-warn)' }}>
                  {strategySignalCount > 0 ? t('chart.ind.strategyCount', { n: strategySignalCount }) : t('chart.ind.strategyNone')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Ehrlichkeit: woher die Zahlen kommen (Server-Serie vs. Browser-Rechnung) */}
      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('chart.ind.sourceNote')}
      </p>
    </div>
  );
}
