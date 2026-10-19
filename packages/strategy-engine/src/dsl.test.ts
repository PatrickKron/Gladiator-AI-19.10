import { describe, expect, it } from 'vitest';
import { evaluateDslAt, parseInstructionDsl, dslExecutionPlan, DSL_TIMEFRAMES, type InstructionDsl } from './dsl.js';
import { DSL_LIMITS_DOC, DSL_SCHEMA_DOC } from './dsl-doc.js';
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

describe('Anweisungs-DSL: Trailing-Stop als Exit (Backtest = Live)', () => {
  const candles = syntheticCandles(300);
  const last = candles.length - 1;

  it('trailingStop.pct ist optional und landet im Setup', () => {
    const r = parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, entry: 'market', trailingStop: { pct: 2.5 } });
    expect(r.ok).toBe(true);
    const withTrail = { ...simpleDsl, trailingStop: { pct: 2.5 } };
    expect(evaluateDslAt(candles, last, withTrail)!.trailPct).toBe(2.5);
    expect(evaluateDslAt(candles, last, simpleDsl)!.trailPct).toBeUndefined();
  });

  it.each([
    ['0 %', { pct: 0 }],
    ['über 50 %', { pct: 60 }],
    ['unbekanntes Feld', { pct: 2, atr: 3 }],
  ])('ungültiger Trailing-Stop (%s) wird abgelehnt', (_l, trailingStop) => {
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, trailingStop }).ok).toBe(false);
  });

  it('die Doku für KI/Workshop beschreibt das Feld (und nennt es nicht mehr als Grenze)', () => {
    expect(DSL_SCHEMA_DOC).toContain('trailingStop');
  });
});

describe('DSL-Erweiterung: ODER-Gruppen (when.any)', () => {
  const up = flatThenMove(260, 40, 'up');
  const lastUp = up.length - 1;

  it('Schema: any = Liste von UND-Listen; all darf dann leer sein, beides leer nicht', () => {
    expect(
      parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [], any: [[{ trend: 'EMA200_up' }], [{ signal: 'BOS' }]] } }).ok,
    ).toBe(true);
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { any: [[{ trend: 'EMA200_up' }]] } }).ok).toBe(true);
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [] } }).ok).toBe(false);
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [], any: [] } }).ok).toBe(false);
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [], any: [[]] } }).ok).toBe(false);
    // max. 5 Zweige
    const six = Array.from({ length: 6 }, () => [{ trend: 'EMA200_up' }]);
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [], any: six } }).ok).toBe(false);
    // ungültige Bedingung in einem Zweig
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, when: { all: [], any: [[{ adx: {} }]] } }).ok).toBe(false);
  });

  it('bestehende DSL ohne any parst unverändert (rückwärtskompatibel)', () => {
    const r = parseInstructionDsl(BLUEPRINT_EXAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dsl.when.any).toBeUndefined();
      expect(r.dsl.when.all).toHaveLength(3);
      expect(r.dsl.breakEvenAfterTp1).toBeUndefined();
      expect(r.dsl.takeProfits).toEqual([{ rr: 1 }, { rr: 2 }]);
    }
  });

  it('mind. ein Zweig voll erfüllt → Setup; Confluence zeigt den getroffenen Zweig', () => {
    const dsl = dslWith([], {
      when: {
        all: [{ priceVs: { kind: 'EMA', period: 50, is: 'above' } }],
        any: [
          [{ supertrend: { direction: 'down' } }], // im Aufwärtstrend falsch
          [{ macd: { event: 'histogram_positive' } }, { adx: { gt: 20 } }], // wahr
        ],
      },
    });
    const hit = evaluateDslAt(up, lastUp, dsl);
    expect(hit).not.toBeNull();
    expect(hit!.confluence).toContain('dsl:priceVs:EMA50:above');
    expect(hit!.confluence).toContain('dsl:any#2');
    expect(hit!.confluence).toContain('dsl:macd:histogram_positive');
    expect(hit!.confluence).toContain('dsl:adx>20');
    expect(hit!.confluence).not.toContain('dsl:any#1');
    expect(hit!.confluence).not.toContain('dsl:supertrend:down');
  });

  it('erster erfüllter Zweig gewinnt (deterministisch)', () => {
    const dsl = dslWith([], {
      when: { all: [], any: [[{ supertrend: { direction: 'up' } }], [{ macd: { event: 'histogram_positive' } }]] },
    });
    const hit = evaluateDslAt(up, lastUp, dsl)!;
    expect(hit.confluence).toContain('dsl:any#1');
    expect(hit.confluence).not.toContain('dsl:any#2');
  });

  it('kein Zweig voll erfüllt → null (auch wenn all erfüllt ist)', () => {
    const dsl = dslWith([], {
      when: {
        all: [{ priceVs: { kind: 'EMA', period: 50, is: 'above' } }],
        // jeder Zweig enthält eine falsche Bedingung
        any: [
          [{ supertrend: { direction: 'down' } }, { macd: { event: 'histogram_positive' } }],
          [{ macd: { event: 'histogram_negative' } }],
        ],
      },
    });
    expect(evaluateDslAt(up, lastUp, dsl)).toBeNull();
  });

  it('look-ahead-frei auch mit ODER-Gruppen', () => {
    const dsl = dslWith([], {
      when: { all: [], any: [[{ supertrend: { direction: 'down' } }], [{ priceVs: { kind: 'EMA', period: 20, is: 'above' } }]] },
    });
    const i = 280;
    expect(JSON.stringify(evaluateDslAt(up, i, dsl))).toBe(JSON.stringify(evaluateDslAt(up.slice(0, i + 1), i, dsl)));
  });
});

describe('DSL-Erweiterung: TP-Gewichte + Break-Even-Schalter (Backtest = Live)', () => {
  const candles = syntheticCandles(300);
  const last = candles.length - 1;

  it('Gewichte optional; wenn gesetzt an JEDEM TP, Summe = 1', () => {
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, takeProfits: [{ rr: 1, weight: 0.7 }, { rr: 2, weight: 0.3 }] }).ok).toBe(true);
    // Rundungs-Toleranz (0.1 + 0.2 ≠ 0.3 in Gleitkomma)
    expect(
      parseInstructionDsl({
        ...BLUEPRINT_EXAMPLE,
        takeProfits: [{ rr: 1, weight: 0.1 }, { rr: 2, weight: 0.2 }, { rr: 3, weight: 0.7 }],
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['Summe ≠ 1', [{ rr: 1, weight: 0.5 }, { rr: 2, weight: 0.3 }]],
    ['nur teilweise gesetzt', [{ rr: 1, weight: 1 }, { rr: 2 }]],
    ['Gewicht 0', [{ rr: 1, weight: 1 }, { rr: 2, weight: 0 }]],
    ['Gewicht > 1', [{ rr: 1, weight: 1.2 }, { rr: 2, weight: -0.2 }]],
    ['4 TPs mit Gewichten (live nur 3 TP-Orders)', [
      { rr: 1, weight: 0.25 }, { rr: 2, weight: 0.25 }, { rr: 3, weight: 0.25 }, { rr: 4, weight: 0.25 },
    ]],
  ])('ungültige TP-Gewichte (%s) werden abgelehnt', (_l, takeProfits) => {
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, takeProfits }).ok).toBe(false);
  });

  it('Gewichte und BE-Schalter landen im Setup; ohne Angabe bleibt das Setup wie bisher', () => {
    const custom = mustParse({
      ...BLUEPRINT_EXAMPLE,
      entry: 'market',
      when: { all: [{ trend: 'EMA200_up' }] },
      takeProfits: [{ rr: 1.5, weight: 0.6 }, { rr: 3, weight: 0.4 }],
      breakEvenAfterTp1: false,
    });
    const s = evaluateDslAt(candles, last, custom)!;
    expect(s.tpWeights).toEqual([0.6, 0.4]);
    expect(s.breakEvenAfterTp1).toBe(false);

    const plain = evaluateDslAt(candles, last, simpleDsl)!;
    expect(plain.tpWeights).toBeUndefined();
    expect(plain.breakEvenAfterTp1).toBeUndefined();
  });

  it('breakEvenAfterTp1 muss boolean sein', () => {
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, breakEvenAfterTp1: 'nein' }).ok).toBe(false);
    expect(parseInstructionDsl({ ...BLUEPRINT_EXAMPLE, breakEvenAfterTp1: true }).ok).toBe(true);
  });

  it('dslExecutionPlan: Ausführungs-Plan für die Live-Ausführung (gleiche Quelle wie das Setup)', () => {
    expect(dslExecutionPlan(simpleDsl)).toEqual({ tpWeights: null, breakEvenAfterTp1: true });
    const custom = mustParse({
      ...BLUEPRINT_EXAMPLE,
      takeProfits: [{ rr: 1, weight: 0.25 }, { rr: 2, weight: 0.75 }],
      breakEvenAfterTp1: false,
    });
    expect(dslExecutionPlan(custom)).toEqual({ tpWeights: [0.25, 0.75], breakEvenAfterTp1: false });
  });

  it('Doku für KI/Workshop beschreibt any, weight und breakEvenAfterTp1; ODER ist keine Grenze mehr', () => {
    expect(DSL_SCHEMA_DOC).toContain('"any"');
    expect(DSL_SCHEMA_DOC).toContain('"weight"');
    expect(DSL_SCHEMA_DOC).toContain('breakEvenAfterTp1');
    expect(DSL_LIMITS_DOC).not.toMatch(/ODER-Verknüpfungen zwischen Bedingungen \(nur UND\)/);
  });
});
