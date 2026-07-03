import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

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
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
