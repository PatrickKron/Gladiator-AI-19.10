import { describe, expect, it } from 'vitest';
import { evaluateDslAt, parseInstructionDsl, type InstructionDsl } from './dsl.js';
import type { Candle } from './types.js';

/** Blueprint-Beispiel (07_ §3) — muss valide sein. */
const BLUEPRINT_EXAMPLE = {
  id: 'btc-london-bos',
  symbol: 'BTC/USDT',
  venueType: 'cex',
  direction: 'long',
  when: {
    session: 'london',
    all: [{ signal: 'BOS' }, { indicator: 'RSI', lt: 50 }, { trend: 'EMA200_up' }],
  },
  entry: 'retest@EMA50',
  stopLoss: { type: 'ATR', mult: 1.5 },
  takeProfits: [{ rr: 1 }, { rr: 2 }],
  risk: { maxLeveragePerTrade: 5, riskPctPerTrade: 1.5 },
};

describe('Anweisungs-DSL: Schema-Validierung (Zod, 07_ §3)', () => {
  it('das Blueprint-Beispiel ist valide', () => {
    const r = parseInstructionDsl(BLUEPRINT_EXAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dsl.id).toBe('btc-london-bos');
      expect(r.dsl.timeframe).toBe('1h'); // Default
      expect(r.dsl.setupType).toBe('swing'); // Default
    }
  });

  it.each([
    ['leeres Objekt', {}],
    ['ungültige Richtung', { ...BLUEPRINT_EXAMPLE, direction: 'sideways' }],
    ['leere Bedingungsliste', { ...BLUEPRINT_EXAMPLE, when: { all: [] } }],
    ['RSI ohne Schwelle', { ...BLUEPRINT_EXAMPLE, when: { all: [{ indicator: 'RSI' }] } }],
    ['negativer ATR-Multiplikator', { ...BLUEPRINT_EXAMPLE, stopLoss: { type: 'ATR', mult: -1 } }],
    ['Hebel über Limit', { ...BLUEPRINT_EXAMPLE, risk: { maxLeveragePerTrade: 500, riskPctPerTrade: 1 } }],
    ['ungültiges Entry-Format', { ...BLUEPRINT_EXAMPLE, entry: 'sofort-rein' }],
  ])('%s wird abgelehnt (mit Fehlerliste)', (_label, input) => {
    const r = parseInstructionDsl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
});

// ── Auswertung auf synthetischen Kerzen (deterministisch, look-ahead-frei) ──

/** Baut einen Uptrend mit Pullback, sodass EMA/RSI/Struktur definiert sind. */
function syntheticCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // Sanfter Aufwärtstrend mit deterministischem Zickzack (kein Math.random — Regel 1)
    const wave = Math.sin(i / 6) * 2;
    const drift = i * 0.15;
    const close = 100 + drift + wave;
    const open = price;
    candles.push({
      ts: new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + i * 3_600_000),
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 1000 + (i % 7) * 50,
    });
    price = close;
  }
  return candles;
}

const simpleDsl: InstructionDsl = parseInstructionDsl({
  id: 'test-ema-long',
  symbol: 'BTC/USDT',
  direction: 'long',
  when: { all: [{ trend: 'EMA200_up' }] },
  entry: 'market',
  stopLoss: { type: 'pct', pct: 2 },
  takeProfits: [{ rr: 1.5 }, { rr: 3 }],
  risk: { maxLeveragePerTrade: 3, riskPctPerTrade: 1 },
}).ok
  ? (parseInstructionDsl({
      id: 'test-ema-long',
      symbol: 'BTC/USDT',
      direction: 'long',
      when: { all: [{ trend: 'EMA200_up' }] },
      entry: 'market',
      stopLoss: { type: 'pct', pct: 2 },
      takeProfits: [{ rr: 1.5 }, { rr: 3 }],
      risk: { maxLeveragePerTrade: 3, riskPctPerTrade: 1 },
    }) as { ok: true; dsl: InstructionDsl }).dsl
  : (undefined as never);

describe('Anweisungs-DSL: Auswertung (evaluateDslAt)', () => {
  const candles = syntheticCandles(300);
  const last = candles.length - 1;

  it('Trend-Bedingung erfüllt → Kandidat mit korrektem SL/TP aus der DSL', () => {
    const c = evaluateDslAt(candles, last, simpleDsl);
    expect(c).not.toBeNull();
    const cand = c!;
    expect(cand.direction).toBe('long');
    const entry = candles[last]!.close;
    expect(cand.entry).toBeCloseTo(entry, 6);
    expect(cand.stopLoss).toBeCloseTo(entry * 0.98, 6); // pct-SL 2 %
    const risk = entry - cand.stopLoss;
    expect(cand.takeProfits[0]).toBeCloseTo(entry + 1.5 * risk, 6);
    expect(cand.takeProfits[1]).toBeCloseTo(entry + 3 * risk, 6);
    expect(cand.confluence).toContain('dsl:EMA200_up');
    expect(cand.score).toBeGreaterThan(0);
    expect(cand.score).toBeLessThanOrEqual(10);
  });

  it('zu wenig Historie (EMA200 undefiniert) → ehrlich null, kein Fantasie-Setup', () => {
    expect(evaluateDslAt(candles.slice(0, 100), 99, simpleDsl)).toBeNull();
  });

  it('Session-Gate: falsche Session → null', () => {
    const dslLondon = { ...simpleDsl, when: { ...simpleDsl.when, session: 'london' as const } };
    // Kerze bei 22:00 UTC = off-Session
    const offCandles = candles.map((c, i) => ({ ...c, ts: new Date(Date.UTC(2026, 0, 1, 22, 0, 0) + i * 60_000) }));
    expect(evaluateDslAt(offCandles, last, dslLondon)).toBeNull();
  });

  it('RSI-Bedingung gt/lt wird am Bar i geprüft', () => {
    const dslRsiImpossible = {
      ...simpleDsl,
      when: { all: [{ indicator: 'RSI' as const, gt: 99.9 }] },
    };
    expect(evaluateDslAt(candles, last, dslRsiImpossible)).toBeNull();
  });

  it('look-ahead-frei: Ergebnis an Bar i ist unabhängig von späteren Kerzen', () => {
    const i = 250;
    const withFuture = evaluateDslAt(candles, i, simpleDsl);
    const withoutFuture = evaluateDslAt(candles.slice(0, i + 1), i, simpleDsl);
    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(withoutFuture));
  });
});
