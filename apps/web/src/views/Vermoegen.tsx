import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { EquityChart, fmt, type EquityPoint } from '../components/EquityChart.js';

/**
 * Vermögen (Phase 2): alle Konten GETRENNT und ehrlich.
 * - Übungskonto = virtuelles Geld (Demo manuell + Paper Agenten) — klar
 *   als Übung markiert, nie mit echtem Geld vermischt.
 * - Echtes Geld = verbundene Börsen (echte Bestände, echte Kurse).
 *   Keine Verbindung ⇒ ehrlich „0 € — noch kein Konto verbunden".
 * - Gesamt in EUR nur mit echtem EUR/USD-Kurs; fehlt er, zeigen wir USD
 *   und sagen das ehrlich dazu.
 * - Zeitverlauf aus stündlichen Snapshots — beginnt mit dem ersten Snapshot.
 */

type Overview = Awaited<ReturnType<typeof trpc.portfolio.overview.query>>;
type History = Awaited<ReturnType<typeof trpc.portfolio.history.query>>;

function eur(n: number | null): string {
  return n === null ? '—' : `${fmt(n, 0)} €`;
}
function usd(n: number | null): string {
  return n === null ? '—' : `${fmt(n, 0)} $`;
}

export function Vermoegen() {
  const { t } = useTranslation();
  const [data, setData] = useState<Overview | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [ov, hist] = await Promise.all([
          trpc.portfolio.overview.query(),
          trpc.portfolio.history.query({ limit: 500 }),
        ]);
        if (cancelled) return;
        setData(ov);
        setHistory(hist);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const rate = data?.eurUsdRate ?? null;
  const practiceEur = data?.practice.totalEur ?? null;
  const realEur = data?.real.connected ? data.real.totalEur : 0;
  const totalEur = practiceEur !== null && realEur !== null ? practiceEur + realEur : null;

  const chartPoints: EquityPoint[] = history
    .filter((h) => h.totalEur !== null)
    .map((h) => ({ ts: new Date(h.ts).toISOString(), equity: h.totalEur! }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('wealth.title')}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('wealth.subtitle')}
        </p>
      </div>

      {error && (
        <div className="glass p-4 text-sm" style={{ color: 'var(--color-neg)' }}>
          {error}
        </div>
      )}

      {/* Gesamt — EINE große Zahl, ehrlich beschriftet */}
      <div className="glass p-6">
        <p className="label">{t('wealth.totalLabel')}</p>
        <p className="num mt-2 text-4xl font-semibold">
          {loading ? '…' : totalEur !== null ? eur(totalEur) : usd((data?.practice.totalUsd ?? 0) + (data?.real.totalUsd ?? 0))}
        </p>
        {rate === null && !loading && (
          <p className="mt-1 text-xs" style={{ color: 'var(--color-warn)' }}>
            {t('wealth.noRate')}
          </p>
        )}
        {rate !== null && (
          <p className="mt-1 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('wealth.rateInfo', { rate: fmt(rate, 4) })}
          </p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Übungskonto (virtuell) */}
        <div className="glass p-5">
          <div className="flex items-center justify-between">
            <p className="font-medium">{t('wealth.practiceTitle')}</p>
            <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}>
              {t('wealth.practiceBadge')}
            </span>
          </div>
          <p className="num mt-3 text-2xl font-semibold">
            {loading ? '…' : practiceEur !== null ? eur(practiceEur) : usd(data?.practice.totalUsd ?? null)}
          </p>
          <div className="mt-3 space-y-1 text-sm" style={{ color: 'var(--color-mut)' }}>
            <p>
              {t('wealth.practiceManual')}:{' '}
              <span className="num" style={{ color: 'var(--color-ink)' }}>
                {usd(data?.practice.demoEquityUsd ?? null)}
              </span>
              {data?.practice.demoIncomplete && !loading && <span title={t('wealth.demoIncomplete')}> ⚠</span>}
            </p>
            <p>
              {t('wealth.practiceAgents')}:{' '}
              <span className="num" style={{ color: 'var(--color-ink)' }}>
                {usd(data?.practice.paperEquityUsd ?? null)}
              </span>
            </p>
          </div>
          <a href="#/trading" className="mt-4 inline-block text-sm underline decoration-dotted" style={{ color: 'var(--color-cyan)' }}>
            {t('wealth.toPractice')}
          </a>
        </div>

        {/* Echtes Geld */}
        <div className="glass p-5">
          <div className="flex items-center justify-between">
            <p className="font-medium">{t('wealth.realTitle')}</p>
            <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(60,220,130,0.45)', color: 'var(--color-pos)' }}>
              {t('wealth.realBadge')}
            </span>
          </div>
          {!data?.real.connected ? (
            <>
              <p className="num mt-3 text-2xl font-semibold">0 €</p>
              <p className="mt-2 text-sm" style={{ color: 'var(--color-mut)' }}>
                {t('wealth.noExchange')}
              </p>
              <a href="#/einstellungen?tab=boersen" className="btn mt-4 inline-block" style={{ fontSize: '0.85rem' }}>
                {t('wealth.connectCta')}
              </a>
            </>
          ) : (
            <>
              <p className="num mt-3 text-2xl font-semibold">
                {data.real.totalEur !== null ? eur(data.real.totalEur) : usd(data.real.totalUsd)}
              </p>
              <div className="mt-3 space-y-3">
                {data.real.accounts.map((acc) => (
                  <div key={acc.connectionId} className="rounded border p-3" style={{ borderColor: 'var(--color-line)' }}>
                    <div className="flex items-center justify-between text-sm">
                      <span>{acc.label || acc.exchangeName}</span>
                      <span className="num">{acc.totalUsd !== null ? usd(acc.totalUsd) : '—'}</span>
                    </div>
                    {acc.error ? (
                      <p className="mt-1 text-xs" style={{ color: 'var(--color-neg)' }}>
                        {acc.error}
                      </p>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs" style={{ color: 'var(--color-mut)' }}>
                        {acc.balances.slice(0, 6).map((b) => (
                          <span key={b.currency} className="num">
                            {fmt(b.total, 6)} {b.currency}
                            {b.valuedUsd === null && <span title={t('wealth.unvalued')}> ⚠</span>}
                          </span>
                        ))}
                        {acc.balances.length === 0 && <span>{t('wealth.emptyBalances')}</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Zeitverlauf */}
      <div className="glass p-5">
        <p className="label mb-3">{t('wealth.historyTitle')}</p>
        <EquityChart points={chartPoints} emptyText={t('wealth.historyEmpty')} unit="€" />
      </div>
    </div>
  );
}
