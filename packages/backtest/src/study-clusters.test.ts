import { describe, expect, it } from 'vitest';
import {
  computeCluster,
  groupRowsByCluster,
  MIN_TRADES_PER_CLUSTER,
  pickOptimalParams,
  studyRowFromDb,
  type StoredCluster,
  type StudyRow,
} from './study-clusters.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-19T00:00:00Z');
const KEY = 'smc-core|BTC/USDT|swing|4h|london|uptrend';

let seq = 0;
function row(daysAgo: number, r: number, over: Partial<StudyRow> = {}): StudyRow {
  seq++;
  return {
    clusterKey: KEY,
    source: 'lab',
    dedupeKey: `t${seq}`,
    exitTs: new Date(NOW.getTime() - daysAgo * DAY),
    rMultiple: r,
    pnlRTpA: r,
    pnlRTpB: r,
    pnlRTpC: r,
    pnlRTpD: r,
    maePct: 0.01,
    ...over,
  };
}

/** n Trades, alternierend Gewinn/Verlust, jüngster zuletzt. */
function series(n: number, win: number, loss: number, over: Partial<StudyRow> = {}): StudyRow[] {
  return Array.from({ length: n }, (_, k) => row(n - k, k % 2 === 0 ? win : loss, { dedupeKey: `d${k}`, ...over }));
}

describe('VDB2-Batch: computeCluster (13_ §4–§8)', () => {
  it('genug Trades + positive Erwartung + Holdout besteht → Empfehlung (L*, S*, Risiko %)', () => {
    const c = computeCluster(KEY, series(60, 2, -1), null, { now: NOW });
    expect(c.tradeCount).toBe(60);
    expect(c.isLowSampleSize).toBe(false);
    expect(c.reason).toBeNull();
    expect(c.recommendation).not.toBeNull();
    expect([1, 2, 3, 5, 7, 10]).toContain(c.recommendation!.leverage);
    expect(c.recommendation!.tpSchema).toBe('A');
    // Half-Kelly: W=0,5, b=2 → Kelly 0,25 → ½ = 12,5 % → Deckel 2 %
    expect(c.recommendation!.riskPct).toBe(2);
    expect(c.holdout.trades).toBe(12); // 20 % von 60
    expect(c.metrics.winrate).toBeCloseTo(0.5, 6);
    expect(c.metrics.expectancy).toBeCloseTo(0.5, 6);
    expect(c.explanation).toContain('Hebel');
  });

  it(`unter MIN_TRADES (${MIN_TRADES_PER_CLUSTER}) → keine Empfehlung, Grund low_sample`, () => {
    const c = computeCluster(KEY, series(20, 2, -1), null, { now: NOW });
    expect(c.isLowSampleSize).toBe(true);
    expect(c.recommendation).toBeNull();
    expect(c.reason).toBe('low_sample');
  });

  it('negative Erwartung → keine Empfehlung (nie den „am wenigsten schlechten" Hebel vorschlagen)', () => {
    const c = computeCluster(KEY, series(60, 0.5, -1), null, { now: NOW });
    expect(c.recommendation).toBeNull();
    expect(c.reason).toBe('negative_expectancy');
  });

  it('Holdout (jüngste 20 %) muss allein bestehen — sonst keine Empfehlung', () => {
    const rows = [...series(48, 2, -1).map((r) => ({ ...r, exitTs: new Date(r.exitTs.getTime() - 30 * DAY) })), ...Array.from({ length: 12 }, (_, k) => row(12 - k, -1, { dedupeKey: `h${k}` }))];
    const c = computeCluster(KEY, rows, null, { now: NOW });
    expect(c.holdout.trades).toBe(12);
    expect(c.holdout.meanR).toBeLessThan(0);
    expect(c.recommendation).toBeNull();
    expect(c.reason).toBe('holdout_failed');
  });

  const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
  const entry = (d: number, over: Record<string, unknown>) => ({ at: ago(d), source: 'study-batch', ...over });

  it('max. Änderung pro Iteration: Hebel springt höchstens eine Stufe gegenüber der Vorwoche', () => {
    // Kleine Verluste: DD bleibt unter dem RAPS-DD-Floor → höherer Hebel gewinnt (ohne Liquidation)
    const rows = series(60, 2, -0.04, { maePct: 0.005 });
    const free = computeCluster(KEY, rows, null, { now: NOW });
    expect(free.recommendation!.leverage).toBe(10);
    const c = computeCluster(KEY, rows, { changelog: [entry(7, { leverage: 2, rapsScore: null })] }, { now: NOW });
    expect(c.recommendation!.leverage).toBe(3);
    expect(c.clampedFrom).toBe(10);
  });

  it('mehrere Läufe in derselben Woche (Labor/Neustart) umgehen die Stufen-Grenze nicht: Referenz bleibt die Vorwoche', () => {
    const rows = series(60, 2, -0.04, { maePct: 0.005 });
    const c = computeCluster(
      KEY,
      rows,
      { changelog: [entry(8, { leverage: 2 }), entry(2, { leverage: 3 }), entry(1, { leverage: 3 })] },
      { now: NOW },
    );
    expect(c.recommendation!.leverage).toBe(3); // eine Stufe über 2 — nicht 5
  });

  it('Alpha-Decay-Markierung: RAPS fällt unter die Hälfte der Vorwoche', () => {
    const c = computeCluster(KEY, series(60, 2, -1), { changelog: [entry(7, { leverage: 1, rapsScore: 1000 })] }, { now: NOW });
    expect(c.alphaDecay).toBe(true);
    expect(c.explanation).toContain('Alpha-Decay');
  });

  it('Changelog wird fortgeschrieben (max. 20 Einträge + Wochen-Referenz bleibt erhalten)', () => {
    const old = [entry(9, { leverage: 2, ref: true }), ...Array.from({ length: 25 }, (_, k) => entry(1, { n: k }))];
    const c = computeCluster(KEY, series(60, 2, -1), { changelog: old }, { now: NOW });
    expect(c.changelog).toHaveLength(21);
    expect(c.changelog[0]).toMatchObject({ ref: true });
    expect(c.changelog[c.changelog.length - 1]).toMatchObject({ source: 'study-batch', tradeCount: 60 });
  });

  it('Paper-Trades kennen nur Schema A → S* = A, B/C/D nie geraten', () => {
    const rows = series(60, 2, -1, { source: 'paper', pnlRTpB: null, pnlRTpC: null, pnlRTpD: null });
    const c = computeCluster(KEY, rows, null, { now: NOW });
    expect(c.recommendation!.tpSchema).toBe('A');
    expect(c.paperCount).toBe(60);
    expect(c.labCount).toBe(0);
  });

  it('keine Trades → ehrlich leer', () => {
    const c = computeCluster(KEY, [], null, { now: NOW });
    expect(c.tradeCount).toBe(0);
    expect(c.recommendation).toBeNull();
    expect(c.reason).toBe('low_sample');
  });
});

describe('groupRowsByCluster: Ebenen + Dedupe', () => {
  it('jede Zeile zählt in exakt/Session/Basis; doppelte Labor-Trades nur einmal', () => {
    const a = row(1, 1, { dedupeKey: 'same' });
    const b = row(1, 1, { dedupeKey: 'same' });
    const c = row(2, 1, { dedupeKey: 'other', clusterKey: 'smc-core|BTC/USDT|swing|4h|asia|downtrend' });
    const g = groupRowsByCluster([a, b, c]);
    expect(g.get(KEY)).toHaveLength(1);
    expect(g.get('smc-core|BTC/USDT|swing|4h|london|all')).toHaveLength(1);
    expect(g.get('smc-core|BTC/USDT|swing|4h|all|all')).toHaveLength(2);
  });
});

describe('studyRowFromDb', () => {
  const base = {
    clusterKey: KEY,
    executedTradeId: null as string | null,
    direction: 'long' as const,
    entryTs: new Date(NOW.getTime() - 2 * DAY),
    exitTs: new Date(NOW.getTime() - DAY),
    rMultiple: '1.5',
    maeBps: '120',
    pnlRTpA: '1.5',
    pnlRTpB: '1.2',
    pnlRTpC: null as string | null,
    pnlRTpD: '2',
  };

  it('Labor-Zeile: mae_bps → Anteil, null bleibt null, Quelle lab', () => {
    const r = studyRowFromDb(base)!;
    expect(r.source).toBe('lab');
    expect(r.maePct).toBeCloseTo(0.012, 9);
    expect(r.pnlRTpC).toBeNull();
    expect(r.pnlRTpB).toBe(1.2);
  });

  it('Paper-Zeile (executed_trade_id gesetzt) → Quelle paper, Dedupe über die Trade-ID', () => {
    const r = studyRowFromDb({ ...base, executedTradeId: 't-1' })!;
    expect(r.source).toBe('paper');
    expect(r.dedupeKey).toBe('paper|t-1');
  });

  it('Alt-Labor-Zeilen (Key …|all|all ohne Trade-ID, mae in R-Einheit) und Zeilen ohne MAE werden verworfen', () => {
    expect(studyRowFromDb({ ...base, clusterKey: 'smc-core|BTC/USDT|swing|4h|all|all' })).toBeNull();
    expect(studyRowFromDb({ ...base, maeBps: null })).toBeNull();
    expect(studyRowFromDb({ ...base, clusterKey: 'alt|format' })).toBeNull();
  });

  it('Zeile ohne jeden TP-Schema-Wert (Paper mit < 3 TPs) trägt nichts zum Gitter bei → verworfen', () => {
    expect(studyRowFromDb({ ...base, executedTradeId: 't-2', pnlRTpA: null, pnlRTpB: null, pnlRTpC: null, pnlRTpD: null })).toBeNull();
  });
});

describe('pickOptimalParams (13_ §7/§8): Risk-Caps + Fallback', () => {
  const caps = { maxLeverage: 5, riskPctPerTrade: 1 };
  function stored(key: string, over: Partial<StoredCluster> = {}): StoredCluster {
    return {
      clusterKey: key,
      optimalLeverage: '7',
      optimalTpSchemaId: 'B',
      optimalRiskPct: '1.5',
      rapsScore: '0.8',
      tradeCount: 80,
      isLowSampleSize: false,
      causalityExplanation: 'Begründung',
      changelog: [{ source: 'study-batch', at: '2026-10-18T00:00:00Z' }],
      updatedAt: NOW,
      ...over,
    };
  }

  it('Hebel und Risiko werden durch die Risk-Settings gedeckelt (nie darüber)', () => {
    const res = pickOptimalParams(new Map([[KEY, stored(KEY)]]), KEY, caps);
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.leverage).toBe(5);
    expect(res.riskPct).toBe(1);
    expect(res.capped).toEqual({ leverage: true, riskPct: true });
    expect(res.tpSchema).toBe('B');
    expect(res.level).toBe('exact');
    expect(res.tradeCount).toBe(80);
  });

  it('exakter Cluster zu klein → Fallback auf den übergeordneten Cluster', () => {
    const parent = 'smc-core|BTC/USDT|swing|4h|london|all';
    const res = pickOptimalParams(
      new Map([
        [KEY, stored(KEY, { tradeCount: 12, isLowSampleSize: true, optimalLeverage: null })],
        [parent, stored(parent, { optimalLeverage: '2', optimalRiskPct: '0.5' })],
      ]),
      KEY,
      caps,
    );
    expect(res).toMatchObject({ available: true, level: 'session', clusterKey: parent, leverage: 2, riskPct: 0.5, capped: { leverage: false, riskPct: false } });
  });

  it('nichts belastbar → null mit Grund (low_sample inkl. größter Stichprobe)', () => {
    const res = pickOptimalParams(new Map([[KEY, stored(KEY, { tradeCount: 12, isLowSampleSize: true })]]), KEY, caps);
    expect(res).toMatchObject({ available: false, reason: 'low_sample', tradeCount: 12, minTrades: MIN_TRADES_PER_CLUSTER });
  });

  it('kein Cluster → no_data; ungültiger Key → invalid_key', () => {
    expect(pickOptimalParams(new Map(), KEY, caps)).toMatchObject({ available: false, reason: 'no_data', tradeCount: 0 });
    expect(pickOptimalParams(new Map(), 'kaputt', caps)).toMatchObject({ available: false, reason: 'invalid_key' });
  });

  it('genug Trades, aber Batch empfahl nichts (z. B. Holdout) → not_recommended', () => {
    const res = pickOptimalParams(new Map([[KEY, stored(KEY, { optimalLeverage: null, optimalTpSchemaId: null, optimalRiskPct: null })]]), KEY, caps);
    expect(res).toMatchObject({ available: false, reason: 'not_recommended', tradeCount: 80 });
  });

  it('Zeilen, die NICHT der Batch geschrieben hat (Alt-Labor-Upsert), werden ignoriert', () => {
    const res = pickOptimalParams(new Map([[KEY, stored(KEY, { changelog: [{ note: 'Labor-Backtest' }] })]]), KEY, caps);
    expect(res).toMatchObject({ available: false, reason: 'no_data' });
  });

  it('Risk-Setting-Hebel < 1 oder Bruchteil → mindestens 1×, abgerundet', () => {
    const res = pickOptimalParams(new Map([[KEY, stored(KEY)]]), KEY, { maxLeverage: 2.7, riskPctPerTrade: 3 });
    expect(res).toMatchObject({ available: true, leverage: 2, riskPct: 1.5, capped: { leverage: true, riskPct: false } });
  });
});
