import { describe, expect, it } from 'vitest';
import { analyzePineScript } from './pine-analyze.js';

const V5_STRATEGY = `//@version=5
strategy("EMA Cross Long", overlay=true, calc_on_every_tick=false)

emaFast = input.int(50, title="Fast EMA")
emaSlow = input.int(200, title="Slow EMA")
riskPct = input.float(1.0, "Risk %")
useHtf  = input.bool(true, "Use HTF filter")

fast = ta.ema(close, emaFast)
slow = ta.ema(close, emaSlow)
rsi  = ta.rsi(close, 14)
atr  = ta.atr(14)
htfTrend = request.security(syminfo.tickerid, "240", close > ta.ema(close, 200))

longCond = ta.crossover(fast, slow) and rsi < 70 and htfTrend
if longCond
    strategy.entry("L", strategy.long) // Einstieg

strategy.exit("XL", from_entry="L", stop=close - 2 * atr, limit=close + 4 * atr)
alertcondition(longCond, title="Long Setup")
`;

const NO_SL_STRATEGY = `//@version=4
strategy("YOLO")
longCond = crossover(sma(close, 9), sma(close, 21))
if longCond
    strategy.entry("L", strategy.long)
`;

describe('analyzePineScript — Struktur-Fakten aus echtem Quelltext', () => {
  it('extrahiert Version, Typ, Titel, Inputs, Indikatoren, Entry/Exit, SL/TP, Alerts, HTF', () => {
    const a = analyzePineScript(V5_STRATEGY);
    expect(a.version).toBe(5);
    expect(a.scriptType).toBe('strategy');
    expect(a.title).toBe('EMA Cross Long');
    expect(a.inputs.map((i) => i.name)).toEqual(['emaFast', 'emaSlow', 'riskPct', 'useHtf']);
    expect(a.inputs[0]).toEqual({ name: 'emaFast', kind: 'int', defval: '50' });
    expect(a.indicators).toEqual(expect.arrayContaining(['ema', 'rsi', 'atr', 'crossover']));
    expect(a.entryCalls).toHaveLength(1);
    expect(a.exitCalls).toHaveLength(1);
    expect(a.hasStopLoss).toBe(true);
    expect(a.hasTakeProfit).toBe(true);
    expect(a.alertCount).toBe(1);
    expect(a.securityTimeframes).toEqual(['240']);
    expect(a.lineCount).toBeGreaterThan(15);
  });

  it('warnt ehrlich: v4 veraltet + fehlender Stop-Loss + fehlender Take-Profit', () => {
    const a = analyzePineScript(NO_SL_STRATEGY);
    expect(a.version).toBe(4);
    expect(a.hasStopLoss).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/veraltet/);
    expect(a.warnings.join(' ')).toMatch(/Stop-Loss/);
    expect(a.warnings.join(' ')).toMatch(/Take-Profit|strategy\.close/);
  });

  it('warnt bei lookahead_on (Repaint-Falle)', () => {
    const code = `//@version=5\nindicator("HTF")\nh = request.security(syminfo.tickerid, "D", close, lookahead=barmerge.lookahead_on)`;
    const a = analyzePineScript(code);
    expect(a.scriptType).toBe('indicator');
    expect(a.warnings.join(' ')).toMatch(/lookahead_on/);
  });

  it('ignoriert // in Strings und liest Version trotzdem aus dem Kommentar', () => {
    const code = `//@version=5\nstrategy("A // B")\ns = "http://example.com"\nplot(close)`;
    const a = analyzePineScript(code);
    expect(a.version).toBe(5);
    expect(a.title).toBe('A // B');
  });

  it('leerer/fremder Text → unknown, keine erfundenen Fakten', () => {
    const a = analyzePineScript('hello world\nkein pine');
    expect(a.version).toBeNull();
    expect(a.scriptType).toBe('unknown');
    expect(a.title).toBeNull();
    expect(a.inputs).toHaveLength(0);
    expect(a.indicators).toHaveLength(0);
  });
});
