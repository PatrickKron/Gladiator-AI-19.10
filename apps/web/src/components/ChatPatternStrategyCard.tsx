import { useState } from 'react';
import type { InstructionDsl } from '@gladiator/strategy-engine';
import { trpc } from '../api.js';
import { loadStrategySlugs, mergeStrategySlugs, saveStrategySlugs } from '../lib/chart-strategy-markers.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { appLocale } from '../lib/locale.js';

/**
 * Interaktive Inline-Karte im Gladiator-Chat (Welle 17):
 * Zeigt das echte Netto-Backtest-Ergebnis einer aus erkannten Mustern
 * erzeugten Strategie, lässt den Nutzer direkt im Chat einen Namen vergeben,
 * die Strategie speichern & offiziell prüfen, im Chart einblenden und nach
 * bestandenem Validitäts-Gate für Paper-Signale aktivieren.
 */

export type PatternDraftData = {
  sessionId: string;
  initialName: string;
  summary: string;
  dsl: InstructionDsl;
  conditions: string[];
  stopLoss: string;
  takeProfits: string;
  backtest: {
    symbol: string;
    timeframe: string;
    candles: number;
    metrics: {
      tradeCount: number;
      netReturnPct: number;
      netPnl: number;
      winRate: number | null;
      profitFactor: number | null;
      maxDrawdownPct: number;
      sharpe: number | null;
    };
  } | null;
  backtestError: string | null;
};

type SaveState = Awaited<ReturnType<typeof trpc.workshop.saveAndValidateVersion.mutate>>;

function toSlug(name: string, fallback: string): string {
  const clean = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return clean.length >= 3 && /^[a-z0-9][a-z0-9-]*$/.test(clean) ? clean : fallback;
}

export function ChatPatternStrategyCard({
  data,
  onNavigate,
}: {
  data: PatternDraftData;
  onNavigate: () => void;
}) {
  const [name, setName] = useState(data.initialName);
  const [busy, setBusy] = useState<'save' | 'promote' | null>(null);
  const [saved, setSaved] = useState<SaveState | null>(null);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [promoted, setPromoted] = useState(false);
  const [chartAdded, setChartAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loc = appLocale();
  const fmtPct = (v: number | null | undefined) =>
    v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toLocaleString(loc, { maximumFractionDigits: 1 })} %`;
  const fmtNum = (v: number | null | undefined) =>
    v == null ? '—' : v.toLocaleString(loc, { maximumFractionDigits: 2 });

  async function saveWithName() {
    const cleanName = name.trim();
    if (cleanName.length < 3) {
      setError('Bitte gib einen Namen mit mindestens 3 Zeichen ein.');
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const slug = toSlug(cleanName, data.dsl.id);
      await trpc.workshop.update.mutate({ id: data.sessionId, name: cleanName });
      const upd = await trpc.workshop.updateDraft.mutate({
        id: data.sessionId,
        dsl: { ...data.dsl, id: slug },
      });
      if (!upd.ok) {
        setError(`Entwurf ungültig: ${upd.errors.join('; ')}`);
        return;
      }
      const res = await trpc.workshop.saveAndValidateVersion.mutate({ id: data.sessionId });
      setSaved(res);
      setSavedSlug(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function activateSignals() {
    if (!saved?.versionId) return;
    setBusy('promote');
    setError(null);
    try {
      await trpc.strategies.promote.mutate({ versionId: saved.versionId });
      setPromoted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aktivierung fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  function showInChart() {
    const slug = savedSlug ?? data.dsl.id;
    const sym = data.dsl.symbol;
    const current = loadStrategySlugs(sym);
    const merged = mergeStrategySlugs(current, [slug]);
    saveStrategySlugs(sym, merged);
    setChartAdded(true);
    window.location.hash = buildChartUrl(sym, data.dsl.timeframe);
    onNavigate();
  }

  const m = data.backtest?.metrics ?? null;

  return (
    <div
      className="rounded-lg border p-3 text-xs space-y-2.5"
      style={{ borderColor: 'rgba(6,182,212,0.45)', background: 'var(--color-bg2)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="font-semibold" style={{ color: 'var(--color-cyan)' }}>
          ✨ Muster-Strategie-Entwurf
        </span>
        <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {data.dsl.symbol} · {data.dsl.timeframe} · {data.dsl.direction.toUpperCase()}
        </span>
      </div>

      {/* Erkannte Regeln */}
      <div className="flex flex-wrap gap-1 text-[10px]">
        {data.conditions.map((c, idx) => (
          <span key={idx} className="num rounded px-1.5 py-0.5" style={{ background: 'rgba(6,182,212,0.12)', color: 'var(--color-cyan)' }}>
            {c}
          </span>
        ))}
        <span className="num rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          SL: {data.stopLoss} · TP: {data.takeProfits}
        </span>
      </div>

      {/* Echte Demo-Backtest-Kennzahlen */}
      {m ? (
        <div className="num grid grid-cols-2 gap-x-3 gap-y-1 rounded border p-2 text-[11px]" style={{ borderColor: 'var(--color-line)' }}>
          <span style={{ color: 'var(--color-mut)' }}>Netto-Rendite</span>
          <span className="text-right font-semibold" style={{ color: m.netReturnPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {fmtPct(m.netReturnPct)}
          </span>
          <span style={{ color: 'var(--color-mut)' }}>Trefferquote</span>
          <span className="text-right">{m.winRate !== null ? `${(m.winRate * 100).toFixed(1)} %` : '—'}</span>
          <span style={{ color: 'var(--color-mut)' }}>Profit-Faktor</span>
          <span className="text-right">{fmtNum(m.profitFactor)}</span>
          <span style={{ color: 'var(--color-mut)' }}>Max Drawdown</span>
          <span className="text-right" style={{ color: 'var(--color-neg)' }}>
            {fmtNum(m.maxDrawdownPct)} %
          </span>
          <span style={{ color: 'var(--color-mut)' }}>Trades / Kerzen</span>
          <span className="text-right">
            {m.tradeCount} / {data.backtest?.candles ?? 0}
          </span>
        </div>
      ) : (
        <p className="text-[11px]" style={{ color: 'var(--color-warn)' }}>
          Backtest-Hinweis: {data.backtestError ?? 'Zu wenig historische Kerzen für dieses Symbol/Timeframe.'}
        </p>
      )}

      {/* Name vergeben & abspeichern */}
      <div className="space-y-1.5">
        <label className="block text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-mut)' }}>
          Name deiner Strategie
        </label>
        <div className="flex gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="z. B. BTC RSI-Divergenz"
            disabled={busy !== null}
            className="field min-w-0 flex-1 px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={busy !== null || name.trim().length < 3}
            onClick={() => void saveWithName()}
            className="btn-primary shrink-0 px-2.5 py-1 text-[11px] disabled:opacity-50"
          >
            {busy === 'save' ? 'Prüfe…' : saved ? '✓ Gespeichert' : '💾 Speichern'}
          </button>
        </div>
      </div>

      {/* Validierungs-Ergebnis + Chart- & Signal-Aktionen */}
      {saved && (
        <div
          className="rounded border p-2 text-[11px] space-y-1"
          style={{ borderColor: saved.verdict?.passed ? 'rgba(34,197,94,0.45)' : 'rgba(245,182,66,0.45)' }}
        >
          <p className="font-medium" style={{ color: saved.verdict?.passed ? 'var(--color-pos)' : 'var(--color-warn)' }}>
            {saved.verdict?.passed
              ? `✓ Gespeichert (v${saved.version}) & 12-Monats-Gate bestanden!`
              : `Gespeichert (v${saved.version}) — Gate-Checks noch offen:`}
          </p>
          {saved.verdict && !saved.verdict.passed && (
            <ul className="space-y-0.5 text-[10px]" style={{ color: 'var(--color-mut)' }}>
              {saved.verdict.checks.filter((c) => !c.passed).map((c, idx) => (
                <li key={idx}>✗ {c.detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p className="text-[11px]" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={showInChart}
          className="tbtn px-2 py-1 text-[11px]"
          style={{ borderColor: 'rgba(6,182,212,0.5)', color: 'var(--color-cyan)' }}
        >
          {chartAdded ? '✓ Im Chart aktiviert' : '📈 Im Chart anzeigen'}
        </button>

        {saved?.verdict?.passed && !promoted && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void activateSignals()}
            className="tbtn px-2 py-1 text-[11px]"
            style={{ borderColor: 'rgba(34,197,94,0.55)', color: 'var(--color-pos)' }}
          >
            {busy === 'promote' ? 'Aktiviere…' : '🔔 Für Paper-Signale aktivieren'}
          </button>
        )}

        {promoted && (
          <span className="rounded border px-2 py-1 text-[11px]" style={{ borderColor: 'rgba(34,197,94,0.5)', color: 'var(--color-pos)' }}>
            ✓ Paper-Signale aktiv
          </span>
        )}

        <a
          href={`#/labor?${new URLSearchParams({
            ...(saved?.strategyId ? { strategy: saved.strategyId } : {}),
            symbol: data.dsl.symbol,
            tf: data.dsl.timeframe,
          }).toString()}`}
          onClick={onNavigate}
          className="tbtn px-2 py-1 text-[11px]"
        >
          🔬 Im Labor optimieren
        </a>
      </div>
    </div>
  );
}
