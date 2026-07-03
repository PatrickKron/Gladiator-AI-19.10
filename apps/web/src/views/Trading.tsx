import { useEffect, useState } from 'react';
import { logout, trpc } from '../api.js';

/**
 * Trading-Seite (09_ §3.9): Paper-Konto, offene Positionen (uPnL gegen echten
 * Live-Preis), Schutz-Orders, Trade-Historie (netto). Alles echt oder ehrlich leer.
 */

type Account = Awaited<ReturnType<typeof trpc.trading.account.query>>;
type Position = Awaited<ReturnType<typeof trpc.trading.positions.query>>[number];
type ProtOrder = Awaited<ReturnType<typeof trpc.trading.protectionOrders.query>>[number];
type Trade = Awaited<ReturnType<typeof trpc.trading.history.query>>[number];

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('de-DE', { maximumFractionDigits: d });
}

export function Trading() {
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [prot, setProt] = useState<ProtOrder[]>([]);
  const [history, setHistory] = useState<Trade[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [a, p, o, h] = await Promise.all([
        trpc.trading.account.query(),
        trpc.trading.positions.query(),
        trpc.trading.protectionOrders.query(),
        trpc.trading.history.query({ limit: 25 }),
      ]);
      setAccount(a);
      setPositions(p);
      setProt(o);
      setHistory(h);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Laden fehlgeschlagen.');
    }
  }

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="relative z-10 mx-auto max-w-6xl px-6 pt-8 pb-16">
      <header className="reveal mb-8 flex flex-wrap items-center justify-between gap-4" style={{ '--stagger': 0 } as React.CSSProperties}>
        <div className="flex items-baseline gap-4">
          <h1 className="wordmark text-lg font-semibold">GLADIATOR</h1>
          <nav className="flex gap-4 text-sm">
            <a href="#/" style={{ color: 'var(--color-mut)' }}>Dashboard</a>
            <a href="#/labor" style={{ color: 'var(--color-mut)' }}>Strategie-Labor</a>
            <a href="#/trading" style={{ color: 'var(--color-cyan)' }}>Trading</a>
          </nav>
          <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}>
            PAPER
          </span>
        </div>
        <button onClick={() => void logout()} className="text-sm" style={{ color: 'var(--color-mut)' }}>Abmelden</button>
      </header>

      {error && <div className="glass mb-6 p-4 text-sm" style={{ color: 'var(--color-neg)' }}>{error}</div>}

      {/* Konto */}
      <section className="grid gap-3 md:grid-cols-4">
        <div className="glass p-4">
          <p className="label">Paper-Equity</p>
          <p className="num mt-1.5 text-2xl font-semibold">{fmt(account?.equity)} $</p>
          <p className="label mt-1">Start {fmt(account?.startEquity, 0)} $</p>
        </div>
        <div className="glass p-4">
          <p className="label">Tages-PnL</p>
          <p className="num mt-1.5 text-2xl font-semibold" style={{ color: (account?.dailyPnlPct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {fmt(account?.dailyPnlPct)} %
          </p>
          <p className="label mt-1">SAFE-001-Limit: −3 %</p>
        </div>
        <div className="glass p-4">
          <p className="label">Offene Positionen</p>
          <p className="num mt-1.5 text-2xl font-semibold">{account?.openPositions ?? '—'}</p>
          <p className="label mt-1">Verlustserie: {account?.consecutiveLosses ?? 0}</p>
        </div>
        <div className="glass p-4">
          <p className="label">Venue</p>
          <p className="num mt-1.5 text-lg font-semibold">{account?.venue.id ?? '—'}</p>
          <p className="mt-1 text-xs" style={{ color: account?.venue.ok ? 'var(--color-pos)' : 'var(--color-warn)' }}>
            {account?.venue.detail ?? '…'}
          </p>
        </div>
      </section>

      {/* Offene Positionen */}
      <section className="glass mt-6 p-6">
        <h2 className="label">Offene Positionen · uPnL gegen echten Live-Preis</h2>
        {positions === null ? (
          <p className="mt-3 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>Lade …</p>
        ) : positions.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>
            Keine offene Position. Bestätige ein Signal im Dashboard — es läuft durch das Risk-Gate und wird hier ausgeführt.
          </p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1.5 pr-3 font-normal">Symbol</th>
                <th className="py-1.5 pr-3 font-normal">Richtung</th>
                <th className="py-1.5 pr-3 text-right font-normal">Menge</th>
                <th className="py-1.5 pr-3 text-right font-normal">Entry</th>
                <th className="py-1.5 pr-3 text-right font-normal">Mark (live)</th>
                <th className="py-1.5 pr-3 text-right font-normal">uPnL $</th>
                <th className="py-1.5 font-normal">Seit</th>
              </tr>
            </thead>
            <tbody className="num">
              {positions.map((p) => (
                <tr key={p.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                  <td className="py-1.5 pr-3">{p.symbol}</td>
                  <td className="py-1.5 pr-3" style={{ color: p.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{p.direction}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(p.qty, 6)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(p.entryPrice)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(p.markPrice)}</td>
                  <td className="py-1.5 pr-3 text-right" style={{ color: (p.unrealizedPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {fmt(p.unrealizedPnl)}
                  </td>
                  <td className="py-1.5">{new Date(p.openedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Schutz-Orders */}
      <section className="glass mt-6 p-6">
        <h2 className="label">Aktive Schutz-Orders (SL/TP) · Monitor prüft minütlich gegen den Live-Preis</h2>
        {prot.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>Keine offenen Schutz-Orders.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1.5 pr-3 font-normal">Symbol</th>
                <th className="py-1.5 pr-3 font-normal">Typ</th>
                <th className="py-1.5 pr-3 text-right font-normal">Trigger</th>
                <th className="py-1.5 pr-3 text-right font-normal">Menge</th>
                <th className="py-1.5 font-normal">clientOrderId</th>
              </tr>
            </thead>
            <tbody className="num">
              {prot.map((o) => (
                <tr key={o.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                  <td className="py-1.5 pr-3">{o.symbol}</td>
                  <td className="py-1.5 pr-3" style={{ color: o.type === 'stop_market' ? 'var(--color-neg)' : 'var(--color-pos)' }}>
                    {o.type === 'stop_market' ? 'Stop-Loss' : 'Take-Profit'}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{fmt(Number(o.price))}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(Number(o.qty), 6)}</td>
                  <td className="py-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>{o.clientOrderId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Historie */}
      <section className="glass mt-6 p-6">
        <h2 className="label">Geschlossene Trades · netto nach Gebühren/Funding</h2>
        {history.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>Noch keine geschlossenen Trades.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1.5 pr-3 font-normal">Exit</th>
                <th className="py-1.5 pr-3 font-normal">Symbol</th>
                <th className="py-1.5 pr-3 font-normal">Richtung</th>
                <th className="py-1.5 pr-3 text-right font-normal">Entry → Exit</th>
                <th className="py-1.5 pr-3 text-right font-normal">Netto $</th>
                <th className="py-1.5 text-right font-normal">R</th>
              </tr>
            </thead>
            <tbody className="num">
              {history.map((t) => (
                <tr key={t.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                  <td className="py-1.5 pr-3">{t.exitTs ? new Date(t.exitTs).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                  <td className="py-1.5 pr-3">{t.symbol}</td>
                  <td className="py-1.5 pr-3" style={{ color: t.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{t.direction}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(Number(t.entryPrice))} → {t.exitPrice ? fmt(Number(t.exitPrice)) : '—'}</td>
                  <td className="py-1.5 pr-3 text-right" style={{ color: Number(t.netPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {fmt(Number(t.netPnl ?? 0))}
                  </td>
                  <td className="py-1.5 text-right">{t.rMultiple ? fmt(Number(t.rMultiple)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="mt-10 text-center text-xs" style={{ color: 'var(--color-mut)' }}>
        Paper-Modus: Ausführung simuliert, Preise echt (Binance). Live-Trading existiert erst nach deiner expliziten Freigabe (Phase 7).
      </footer>
    </div>
  );
}
