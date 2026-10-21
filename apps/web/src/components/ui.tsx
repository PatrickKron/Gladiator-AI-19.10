import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { appLocale } from '../lib/locale.js';

/** Gemeinsame UI-Bausteine (Design-System v2 Neon-Dual) — Loading/Empty/Error/NotConnected sind Pflicht-States (09_ §1). */

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <header className="reveal mb-8" style={{ '--stagger': 0 } as React.CSSProperties}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && (
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {subtitle}
            </p>
          )}
        </div>
        {right}
      </div>
      <div
        className="mt-5 h-px w-full"
        style={{ background: 'linear-gradient(90deg, rgba(46,124,246,0.5), rgba(139,92,246,0.35), transparent 80%)' }}
      />
    </header>
  );
}

export function Panel({
  label,
  children,
  stagger = 1,
  className = '',
}: {
  label?: string;
  children: ReactNode;
  stagger?: number;
  className?: string;
}) {
  return (
    <section className={`glass glass-hover reveal p-6 ${className}`} style={{ '--stagger': stagger } as React.CSSProperties}>
      {label && <h2 className="label">{label}</h2>}
      {children}
    </section>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <p className="mt-4 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>
      {t('common.loading')}
    </p>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="glass mb-6 p-4 text-sm" style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
      {message}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <p className="mt-4 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
      {text}
    </p>
  );
}

/** Ehrlicher „nicht verbunden"-Zustand — Pflicht statt Fake (Regel 1). */
export function NotConnected({ detail }: { detail: string }) {
  const { t } = useTranslation();
  return (
    <div
      className="mt-4 rounded-[0.625rem] border border-dashed p-4"
      style={{ borderColor: 'rgba(139,92,246,0.35)' }}
    >
      <p className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--color-violet)' }}>
        <span className="neon-dot neon-dot--violet" /> {t('common.notConnected').toUpperCase()}
      </p>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {detail}
      </p>
    </div>
  );
}

export function StatusDot({ on }: { on: boolean }) {
  return <span className={`neon-dot ${on ? 'neon-dot--on' : 'neon-dot--off'}`} />;
}

export function fmtNum(n: number, digits = 2): string {
  return n.toLocaleString(appLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(n: number): string {
  return n.toLocaleString(appLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Tab-Leiste (einheitlich auf allen Seiten): Unterstrich-Stil, horizontal scrollbar auf Mobile. */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="mb-5 flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--color-line)' }}>
      {tabs.map((tb) => (
        <button
          key={tb.id}
          role="tab"
          aria-selected={active === tb.id}
          onClick={() => onChange(tb.id)}
          className="shrink-0 border-b-2 px-4 py-2 text-sm transition-colors"
          style={active === tb.id ? { borderColor: 'var(--color-cyan)', color: 'var(--color-ink)' } : { borderColor: 'transparent', color: 'var(--color-mut)' }}
        >
          {tb.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Ladefehler sichtbar machen statt sie als „leer" zu tarnen: `fail(name, fallback)`
 * als catch-Handler setzt den leeren Zustand UND merkt sich die Quelle.
 * <LoadFailures> zeigt dann ehrlich, was fehlt — mit „Erneut versuchen".
 */
export function useLoadFailures() {
  const [failed, setFailed] = useState<string[]>([]);
  const fail = useCallback(
    (name: string, fallback?: () => void) => (err: unknown) => {
      fallback?.();
      console.warn(`[load] ${name}:`, err);
      setFailed((f) => (f.includes(name) ? f : [...f, name]));
    },
    [],
  );
  const reset = useCallback(() => setFailed([]), []);
  return { failed, fail, reset };
}

export function LoadFailures({ failed, onRetry }: { failed: string[]; onRetry: () => void }) {
  const { t } = useTranslation();
  if (failed.length === 0) return null;
  return (
    <div
      role="alert"
      className="glass mb-5 flex flex-wrap items-center justify-between gap-3 p-4 text-sm"
      style={{ borderColor: 'rgba(255,92,108,0.4)' }}
    >
      <span style={{ color: 'var(--color-neg)' }}>
        {t('ia.loadFailed', { n: failed.length })} <span className="num text-xs" style={{ color: 'var(--color-mut)' }}>({failed.join(', ')})</span>
      </span>
      <button onClick={onRetry} className="rounded-[0.625rem] border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}>
        {t('common.retry')}
      </button>
    </div>
  );
}
