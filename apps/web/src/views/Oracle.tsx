import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { NotConnected, PageHeader, Panel } from '../components/ui.js';

/**
 * Oracle / Makro-Synapse (09_ §3.4): Quadranten zeigen NUR echte Werte —
 * FRED/VIX/COT/On-Chain sind noch nicht angebunden und stehen ehrlich auf
 * „nicht verbunden" (kein PREVIEW_MODE, Regel 1). Was heute schon echt ist:
 * EMA200-Regime + Marktphase je Symbol aus den eigenen Kerzen.
 */

type Regime = { symbol: string; emaRegime: 'above' | 'below' | null; marketPhase: 'bull' | 'bear' | null };

const QUADRANTS = [
  { key: 'oracle.gravity', source: 'FRED (Zinsen/Liquidität)' },
  { key: 'oracle.pulse', source: 'VIX/DXY' },
  { key: 'oracle.footprint', source: 'COT' },
  { key: 'oracle.dna', source: 'On-Chain' },
];

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

export function Oracle() {
  const { t } = useTranslation();
  const [regimes, setRegimes] = useState<Regime[] | null>(null);

  useEffect(() => {
    // Echte Regime-Ableitung aus eigenen 1h-Kerzen (dieselbe Logik wie die Engine nutzt).
    void Promise.all(
      SYMBOLS.map(async (symbol) => {
        try {
          const candles = await trpc.market.ohlcv.query({ symbol, timeframe: '1h', limit: 400 });
          if (candles.length < 220) return { symbol, emaRegime: null, marketPhase: null };
          const closes = candles.map((c) => c.close);
          const k = 2 / 201;
          let value = closes.slice(0, 200).reduce((a, b) => a + b, 0) / 200;
          for (let i = 200; i < closes.length; i++) value = closes[i]! * k + value * (1 - k);
          const last = closes[closes.length - 1]!;
          return {
            symbol,
            emaRegime: (last >= value ? 'above' : 'below') as 'above' | 'below',
            marketPhase: (last >= value ? 'bull' : 'bear') as 'bull' | 'bear',
          };
        } catch {
          return { symbol, emaRegime: null, marketPhase: null };
        }
      }),
    ).then(setRegimes);
  }, []);

  return (
    <div>
      <PageHeader title={t('oracle.title')} subtitle={t('oracle.subtitle')} />

      {/* GRS-Zentrum: Orrery-artiger Ring — ehrlich ohne Score, solange Quellen fehlen */}
      <Panel stagger={1} className="relative overflow-hidden">
        <div className="flex flex-col items-center py-6">
          <div className="relative flex h-44 w-44 items-center justify-center">
            <div
              className="absolute inset-0 rounded-full border"
              style={{ borderColor: 'rgba(46,124,246,0.35)', boxShadow: '0 0 40px rgba(46,124,246,0.15), inset 0 0 30px rgba(46,124,246,0.08)' }}
            />
            <div className="absolute inset-4 rounded-full border border-dashed" style={{ borderColor: 'rgba(139,92,246,0.3)' }} />
            <div className="absolute inset-8 rounded-full border" style={{ borderColor: 'rgba(79,209,255,0.2)' }} />
            <div className="text-center">
              <p className="num text-3xl font-semibold" style={{ color: 'var(--color-mut)' }}>
                —
              </p>
              <p className="label mt-1">{t('oracle.grs')}</p>
            </div>
          </div>
          <p className="mt-5 max-w-xl text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('oracle.honest')}
          </p>
        </div>
      </Panel>

      {/* Quadranten — alle ehrlich „nicht verbunden" */}
      <section className="mt-5 grid gap-5 md:grid-cols-2">
        {QUADRANTS.map((q, i) => (
          <Panel key={q.key} label={t(q.key)} stagger={i + 2}>
            <NotConnected detail={t('oracle.disconnected')} />
          </Panel>
        ))}
      </section>

      {/* Was heute echt ist: Regime aus eigenen Kerzen */}
      <Panel label={t('oracle.marketPhase')} stagger={6} className="mt-5">
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {(regimes ?? SYMBOLS.map((symbol) => ({ symbol, emaRegime: null, marketPhase: null }))).map((r) => (
            <div key={r.symbol} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
              <p className="text-sm font-medium">{r.symbol.replace('/USDT', '')}</p>
              <p className="label mt-2">{t('oracle.emaRegime')}</p>
              <p className="num mt-0.5 text-sm" style={{ color: r.emaRegime === 'above' ? 'var(--color-pos)' : r.emaRegime === 'below' ? 'var(--color-neg)' : 'var(--color-mut)' }}>
                {r.emaRegime ?? '…'}
              </p>
              <p className="label mt-2">{t('oracle.marketPhase')}</p>
              <p className="num mt-0.5 text-sm" style={{ color: r.marketPhase === 'bull' ? 'var(--color-pos)' : r.marketPhase === 'bear' ? 'var(--color-neg)' : 'var(--color-mut)' }}>
                {r.marketPhase ?? '…'}
              </p>
            </div>
          ))}
        </div>
        <p className="label mt-3">{t('oracle.fromOwnData')}</p>
      </Panel>
    </div>
  );
}
