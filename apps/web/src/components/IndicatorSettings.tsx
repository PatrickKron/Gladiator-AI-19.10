import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clampNumber, editableInputs, effectivePlotStyle, inputRows, type InstanceStyle, type MenuEntry, type MenuInput } from '../lib/indicator-menu.js';

/**
 * Einstellungen eines Chart-Indikators, aus seiner Eingabe-Deklaration gebaut
 * (Pine-Inputs: Zahl, Schalter, Auswahl, Quelle, Farbe) plus Darstellung je
 * Plot. Lokaler Entwurf, „Übernehmen“ speichert in der DB und rechnet neu —
 * nicht bei jedem Tastendruck (Chart-Neubau wäre träge, halbe Zahlen falsch).
 */

const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];

function NumField({ decl, value, disabled, onCommit }: { decl: MenuInput; value: number; disabled: boolean; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = clampNumber(draft, decl, value);
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      inputMode="decimal"
      aria-label={decl.title ?? decl.id}
      className="field num w-20 px-2 py-1 text-center text-xs disabled:opacity-40"
    />
  );
}

const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

export function IndicatorSettings({
  entry,
  label,
  inputs: initialInputs,
  style: initialStyle,
  onApply,
  onClose,
}: {
  entry: MenuEntry;
  label: string;
  inputs: Record<string, unknown>;
  style: InstanceStyle;
  onApply: (inputs: Record<string, unknown>, style: InstanceStyle) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>({ ...initialInputs });
  const [style, setStyle] = useState<InstanceStyle>(initialStyle ? { ...initialStyle, plots: { ...(initialStyle.plots ?? {}) } } : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (id: string, v: unknown) => setValues((prev) => ({ ...prev, [id]: v }));
  const setPlot = (id: string, patch: { visible?: boolean; color?: string; lineWidth?: number }) =>
    setStyle((prev) => ({ ...(prev ?? {}), plots: { ...(prev?.plots ?? {}), [id]: { ...(prev?.plots?.[id] ?? {}), ...patch } } }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = inputRows(editableInputs(entry, values));
  const plots = entry.plots.filter((p) => p.color !== 'transparent');

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onApply(values, style);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const field = (decl: MenuInput, active: boolean) => {
    const v = values[decl.id];
    const dis = !active;
    switch (decl.type) {
      case 'int':
      case 'float':
        return <NumField decl={decl} value={typeof v === 'number' ? v : Number(decl.defval)} disabled={dis} onCommit={(n) => set(decl.id, n)} />;
      case 'bool':
        return <input type="checkbox" checked={Boolean(v)} disabled={dis} onChange={(e) => set(decl.id, e.target.checked)} className="accent-[#8b5cf6]" aria-label={decl.title ?? decl.id} />;
      case 'source':
      case 'string':
      case 'timeframe':
      case 'session': {
        const opts = decl.type === 'source' ? SOURCES : decl.options;
        if (opts && opts.length > 0) {
          return (
            <select value={String(v ?? decl.defval)} disabled={dis} onChange={(e) => set(decl.id, e.target.value)} className="field cursor-pointer px-2 py-1 text-xs disabled:opacity-40" aria-label={decl.title ?? decl.id}>
              {opts.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          );
        }
        if (decl.type === 'string') {
          return <input value={String(v ?? '')} disabled={dis} maxLength={64} onChange={(e) => set(decl.id, e.target.value)} className="field w-40 px-2 py-1 text-xs disabled:opacity-40" aria-label={decl.title ?? decl.id} />;
        }
        return <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>{String(v ?? decl.defval)} · {t('chart.ind.readOnly')}</span>;
      }
      case 'color': {
        const c = String(v ?? decl.defval);
        return isHex(c) ? (
          <input type="color" value={c} disabled={dis} onChange={(e) => set(decl.id, e.target.value)} aria-label={decl.title ?? decl.id} className="h-6 w-9 cursor-pointer bg-transparent" />
        ) : (
          <input value={c} disabled={dis} maxLength={40} onChange={(e) => set(decl.id, e.target.value)} className="field num w-36 px-2 py-1 text-xs" aria-label={decl.title ?? decl.id} />
        );
      }
      default:
        return <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>{String(v ?? decl.defval)} · {t('chart.ind.readOnly')}</span>;
    }
  };

  let lastGroup: string | null | undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh]" style={{ background: 'rgba(3,4,14,0.72)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div role="dialog" aria-label={label} className="glass w-full max-w-xl overflow-hidden p-0" style={{ borderColor: 'rgba(139,92,246,0.45)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
          <div>
            <p className="text-sm font-semibold">{label}</p>
            <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
              {entry.name}
            </p>
          </div>
          <button type="button" onClick={onClose} className="px-2 text-sm" style={{ color: 'var(--color-mut)' }} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="label mb-1.5">{t('chart.ind.inputsTitle')}</p>
          {rows.length === 0 && <p className="text-xs" style={{ color: 'var(--color-mut)' }}>—</p>}
          <div className="flex flex-col gap-1.5">
            {rows.map((row, i) => {
              const header = row.group !== lastGroup && row.group !== null ? row.group : null;
              lastGroup = row.group;
              return (
                <div key={i}>
                  {header && (
                    <p className="label mb-1 mt-2" style={{ color: 'var(--color-cyan)' }}>
                      {header}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {row.inputs.map(({ decl, active }) => (
                      <label key={decl.id} className="flex items-center gap-2 text-xs" style={{ color: active ? 'var(--color-ink)' : 'var(--color-mut)' }} title={decl.tooltip}>
                        <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                          {decl.title ?? decl.id}
                        </span>
                        {field(decl, active)}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {plots.length > 0 && (
            <>
              <p className="label mb-1.5 mt-4">{t('chart.ind.styleTitle')}</p>
              <div className="flex flex-col gap-1.5">
                {plots.map((p) => {
                  const st = effectivePlotStyle(p, style);
                  return (
                    <div key={p.id} className="flex flex-wrap items-center gap-3 text-xs">
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={st.visible} onChange={(e) => setPlot(p.id, { visible: e.target.checked })} className="accent-[#8b5cf6]" aria-label={`${p.title} ${t('chart.ind.plotVisible')}`} />
                        <span style={{ color: st.visible ? 'var(--color-ink)' : 'var(--color-mut)' }}>{p.title}</span>
                      </label>
                      <label className="flex items-center gap-1.5">
                        <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                          {t('chart.ind.color')}
                        </span>
                        {isHex(st.color) ? (
                          <input type="color" value={st.color} onChange={(e) => setPlot(p.id, { color: e.target.value })} className="h-6 w-9 cursor-pointer bg-transparent" aria-label={`${p.title} ${t('chart.ind.color')}`} />
                        ) : (
                          <input value={st.color} maxLength={40} onChange={(e) => setPlot(p.id, { color: e.target.value })} className="field num w-32 px-2 py-1 text-xs" aria-label={`${p.title} ${t('chart.ind.color')}`} />
                        )}
                      </label>
                      <label className="flex items-center gap-1.5">
                        <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                          {t('chart.ind.width')}
                        </span>
                        <select value={st.lineWidth} onChange={(e) => setPlot(p.id, { lineWidth: Number(e.target.value) })} className="field cursor-pointer px-2 py-1 text-xs" aria-label={`${p.title} ${t('chart.ind.width')}`}>
                          {[1, 2, 3, 4].map((w) => (
                            <option key={w} value={w}>
                              {w}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
          <button
            type="button"
            onClick={() => {
              setValues({ ...entry.defaultInputs });
              setStyle(null);
            }}
            className="rounded border px-2 py-1 text-[11px]"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
          >
            {t('chart.ind.reset')}
          </button>
          <span className="flex items-center gap-2">
            {err && (
              <span className="text-[11px]" style={{ color: 'var(--color-neg)' }}>
                {err}
              </span>
            )}
            <button type="button" onClick={onClose} className="rounded border px-2 py-1 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
              {t('chart.ind.cancel')}
            </button>
            <button type="button" disabled={busy} onClick={() => void apply()} className="rounded border px-3 py-1 text-[11px] disabled:opacity-40" style={{ borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-cyan)', background: 'rgba(79,209,255,0.08)' }}>
              {t('chart.ind.apply')}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
