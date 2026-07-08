import { describe, expect, it } from 'vitest';
import { evaluateDslAt, parseInstructionDsl, DSL_TIMEFRAMES, type InstructionDsl } from './dsl.js';
import { DSL_SCHEMA_DOC } from './dsl-doc.js';
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

// ── Workshop-Erweiterung: neue Bedingungen + Timeframes ─────────────────────

/** Parst oder wirft — für Tests, die eine valide DSL voraussetzen. */
function mustParse(input: unknown): InstructionDsl {
  const r = parseInstructionDsl(input);
  if (!r.ok) throw new Error(`DSL unerwartet ungültig: ${r.errors.join('; ')}`);
  return r.dsl;
}

/** Basis-DSL, deren Bedingungsliste je Test ersetzt wird. */
function dslWith(all: unknown[], overrides: Record<string, unknown> = {}): InstructionDsl {
  return mustParse({
    id: 'test-workshop',
    symbol: 'BTC/USDT',
    direction: 'long',
    when: { all },
    entry: 'market',
    stopLoss: { type: 'pct', pct: 2 },
    takeProfits: [{ rr: 2 }],
    risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
    ...overrides,
  });
}

/** nFlat flache Bars (Range 1), danach nMove Bars mit ±1 %/Bar — deterministisch. */
function flatThenMove(nFlat: number, nMove: number, direction: 'up' | 'down'): Candle[] {
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < nFlat + nMove; i++) {
    const open = close;
    if (i >= nFlat) close = direction === 'up' ? close * 1.01 : close * 0.99;
    candles.push({
      ts: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 1000,
    });
  }
  return candles;
}

describe('DSL-Erweiterung: Schema (neue Bedingungen, 10 Timeframes)', () => {
  it('alle 10 System-Timeframes sind zulässig; unbekannte nicht', () => {
    expect(DSL_TIMEFRAMES).toHaveLength(10);
    for (const tf of DSL_TIMEFRAMES) {
      const r = parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, timeframe: tf });
      expect(r.ok, `Timeframe ${tf} muss valide sein`).toBe(true);
    }
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, timeframe: '3m' }).ok).toBe(false);
  });

  it('maCross: Defaults (EMA, withinBars 1) + fast<slow-Pflicht', () => {
    const dsl = dslWith([{ maCross: { fast: 20, slow: 50, cross: 'bullish' } }]);
    const cond = dsl.when.all[0]!;
    expect('maCross' in cond && cond.maCross.kind).toBe('EMA');
    expect('maCross' in cond && cond.maCross.withinBars).toBe(1);
    expect(parseInstructionDsl({
      ...BLUEPRINT_EXAMPLE,
      when: { all: [{ maCross: { fast: 50, slow: 20, cross: 'bullish' } }] },
    }).ok).toBe(false);
  });

  it.each([
    ['macd fast>=slow', { macd: { fast: 26, slow: 12, event: 'bullish_cross' } }],
    ['stochastic ohne Kriterium', { stochastic: { kPeriod: 14 } }],
    ['adx ohne gt/lt', { adx: { period: 14 } }],
    ['unbekannter Bedingungstyp', { vwapCross: { period: 20 } }],
  ])('%s wird abgelehnt', (_label, cond) => {
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [cond] } }).ok).toBe(false);
  });

  it('when.all erlaubt bis 10 Bedingungen, 11 nicht', () => {
    const ten = Array.from({ length: 10 }, () => ({ trend: 'EMA200_up' }));
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: ten } }).ok).toBe(true);
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [...ten, { trend: 'EMA200_up' }] } }).ok).toBe(false);
  });

  it('DSL_SCHEMA_DOC erwähnt jeden Bedingungs-Schlüssel (Prompt bleibt synchron)', () => {
    for (const key of ['signal', 'indicator', 'trend', 'maCross', 'priceVs', 'macd', 'bollinger', 'stochastic', 'adx', 'supertrend']) {
      expect(DSL_SCHEMA_DOC).toContain(key);
    }
    for (const tf of DSL_TIMEFRAMES) expect(DSL_SCHEMA_DOC).toContain(`"${tf}"`);
  });
});

describe('DSL-Erweiterung: Auswertung der neuen Bedingungen', () => {
  const up = flatThenMove(260, 40, 'up');
  const down = flatThenMove(260, 40, 'down');
  const lastUp = up.length - 1;
  const lastDown = down.length - 1;

  it('priceVs: Preis über EMA50 im Aufwärtstrend erfüllt; below → null', () => {
    const above = dslWith([{ priceVs: { kind: 'EMA', period: 50, is: 'above' } }]);
    const below = dslWith([{ priceVs: { kind: 'EMA', period: 50, is: 'below' } }]);
    const hit = evaluateDslAt(up, lastUp, above);
    expect(hit).not.toBeNull();
    expect(hit!.confluence).toContain('dsl:priceVs:EMA50:above');
    expect(evaluateDslAt(up, lastUp, below)).toBeNull();
  });

  it('maCross: bullisher EMA5/EMA20-Cross nach Trendstart wird im Fenster erkannt', () => {
    const dsl = dslWith([{ maCross: { kind: 'EMA', fast: 5, slow: 20, cross: 'bullish', withinBars: 20 } }]);
    // Cross passiert wenige Bars nach Bar 260 → bei Bar 275 liegt er im 20-Bar-Fenster.
    const hit = evaluateDslAt(up, 275, dsl);
    expect(hit).not.toBeNull();
    expect(hit!.confluence).toContain('dsl:maCross:EMA5/20:bullish');
    // In der flachen Phase (Bar 250) gab es keinen Cross.
    expect(evaluateDslAt(up, 250, dsl)).toBeNull();
    // Bearisher Cross existiert im Aufwärtsszenario nicht.
    const bear = dslWith([{ maCross: { kind: 'EMA', fast: 5, slow: 20, cross: 'bearish', withinBars: 20 } }]);
    expect(evaluateDslAt(up, 275, bear)).toBeNull();
  });

  it('macd: histogram_positive im Aufwärtstrend erfüllt, histogram_negative → null', () => {
    const pos = dslWith([{ macd: { event: 'histogram_positive' } }]);
    const neg = dslWith([{ macd: { event: 'histogram_negative' } }]);
    expect(evaluateDslAt(up, lastUp, pos)).not.toBeNull();
    expect(evaluateDslAt(up, lastUp, neg)).toBeNull();
  });

  it('macd: bullish_cross nach Trendstart im Fenster erkannt', () => {
    const dsl = dslWith([{ macd: { event: 'bullish_cross', withinBars: 20 } }]);
    expect(evaluateDslAt(up, 275, dsl)).not.toBeNull();
  });

  it('bollinger: close_above_middle im Aufwärtstrend erfüllt, close_below_lower → null', () => {
    const mid = dslWith([{ bollinger: { event: 'close_above_middle' } }]);
    const low = dslWith([{ bollinger: { event: 'close_below_lower' } }]);
    expect(evaluateDslAt(up, lastUp, mid)).not.toBeNull();
    expect(evaluateDslAt(up, lastUp, low)).toBeNull();
  });

  it('stochastic: kGt im Aufwärtstrend erfüllt, kLt → null', () => {
    const gt = dslWith([{ stochastic: { kGt: 60 } }]);
    const lt = dslWith([{ stochastic: { kLt: 20 } }]);
    expect(evaluateDslAt(up, lastUp, gt)).not.toBeNull();
    expect(evaluateDslAt(up, lastUp, lt)).toBeNull();
  });

  it('adx: gt 20 nach 40 Trend-Bars erfüllt, lt 5 → null', () => {
    const gt = dslWith([{ adx: { gt: 20 } }]);
    const lt = dslWith([{ adx: { lt: 5 } }]);
    expect(evaluateDslAt(up, lastUp, gt)).not.toBeNull();
    expect(evaluateDslAt(up, lastUp, lt)).toBeNull();
  });

  it('supertrend: direction up im Aufwärtstrend erfüllt, down → null (und umgekehrt im Abwärtstrend)', () => {
    const upCond = dslWith([{ supertrend: { direction: 'up' } }]);
    const downCond = dslWith([{ supertrend: { direction: 'down' } }], { direction: 'short' });
    expect(evaluateDslAt(up, lastUp, upCond)).not.toBeNull();
    expect(evaluateDslAt(up, lastUp, dslWith([{ supertrend: { direction: 'down' } }]))).toBeNull();
    expect(evaluateDslAt(down, lastDown, downCond)).not.toBeNull();
  });

  it('RSI mit eigener Periode: gt 60 im Aufwärtstrend erfüllt', () => {
    const dsl = dslWith([{ indicator: 'RSI', gt: 60, period: 5 }]);
    expect(evaluateDslAt(up, lastUp, dsl)).not.toBeNull();
  });

  it('look-ahead-frei: neue Bedingungen sehen keine späteren Kerzen', () => {
    const dsl = dslWith([
      { maCross: { kind: 'EMA', fast: 5, slow: 20, cross: 'bullish', withinBars: 20 } },
      { macd: { event: 'histogram_positive' } },
      { supertrend: { direction: 'up' } },
    ]);
    const i = 275;
    const withFuture = evaluateDslAt(up, i, dsl);
    const withoutFuture = evaluateDslAt(up.slice(0, i + 1), i, dsl);
    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(withoutFuture));
  });
});
