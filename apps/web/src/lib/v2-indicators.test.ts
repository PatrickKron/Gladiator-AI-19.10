import { describe, expect, it, vi } from 'vitest';
import { MA_PALETTE } from './ma-colors.js';
import { importV2Indicators, importV2IndicatorsOnce, mapV2Config, parseV2Raw, planV2Import, v2ImportedKey, v2IndicatorKey, type ImportDeps } from './v2-indicators.js';

/** Gespeicherte v2-Konfiguration, wie v2 (lib/indicators.ts → saveIndicatorConfig) sie schrieb. */
const V2_FULL = {
  mas: [
    { kind: 'ema', period: 21 },
    { kind: 'sma', period: 50 },
    { kind: 'ema', period: 200 },
  ],
  rsi: { on: true, period: 9 },
  macd: { on: true, fast: 8, slow: 21, signal: 5 },
  bollinger: { on: true, period: 30, mult: 2.5 },
  strategySlugs: ['pine-breakout', 'dsl-trend'],
};

function fakeStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('Schlüssel im Browser', () => {
  it('v2-Schlüssel je Symbol (wie v2: Großbuchstaben) und eigener Merker „übernommen"', () => {
    expect(v2IndicatorKey('btc/usdt')).toBe('gladiator.chartIndicators.BTC/USDT');
    expect(v2ImportedKey('BTC/USDT')).toBe('gladiator.chartIndicators.imported.BTC/USDT');
  });
});

describe('mapV2Config: v2-Konfiguration → Einträge der Indikator-Bibliothek', () => {
  it('EMA/SMA mit Periode, RSI, MACD, Bollinger und Strategie-Marker', () => {
    expect(mapV2Config(V2_FULL)).toEqual({
      items: [
        { indicatorId: 'ema', inputs: { length: 21 } },
        { indicatorId: 'sma', inputs: { len: 50 } },
        { indicatorId: 'ema', inputs: { length: 200 } },
        { indicatorId: 'bb', inputs: { length: 30, mult: 2.5 } },
        // v2-RSI zeigte nur die RSI-Linie (keine Glättungslinie) → maType None
        { indicatorId: 'rsi', inputs: { length: 9, maType: 'None' } },
        { indicatorId: 'macd', inputs: { fastLength: 8, slowLength: 21, signalLength: 5 } },
      ],
      strategySlugs: ['pine-breakout', 'dsl-trend'],
    });
  });

  it('ausgeschaltete Oszillatoren/Bänder werden nicht übernommen (v2 zeigte sie nicht)', () => {
    const r = mapV2Config({ ...V2_FULL, rsi: { on: false, period: 9 }, macd: { on: false, fast: 8, slow: 21, signal: 5 }, bollinger: { period: 30, mult: 2 } });
    expect(r.items.map((i) => i.indicatorId)).toEqual(['ema', 'sma', 'ema']);
  });

  it('kaputte Einträge werden ignoriert — nie ein erfundener Ersatzwert', () => {
    const r = mapV2Config({
      mas: [
        { kind: 'wma', period: 20 }, // unbekannte Art
        { kind: 'ema', period: '20' }, // keine Zahl
        { kind: 'ema', period: 1 }, // unter v2-Minimum (2)
        { kind: 'sma', period: 401 }, // über v2-Maximum (400)
        { kind: 'ema', period: 12.5 }, // keine ganze Zahl
        null,
        'ema',
        { kind: 'sma', period: 10 }, // gültig
      ],
      rsi: { on: true, period: 0 },
      macd: { on: true, fast: 26, slow: 12, signal: 9 }, // fast ≥ slow
      bollinger: { on: true, period: 20, mult: 9 }, // Faktor über 5
      strategySlugs: ['ok', '', 3, 'ok', null],
    });
    expect(r.items).toEqual([{ indicatorId: 'sma', inputs: { len: 10 } }]);
    expect(r.strategySlugs).toEqual(['ok']);
  });

  it('wie v2: höchstens 6 gültige Durchschnitte, höchstens 20 Strategie-Marker', () => {
    const mas = Array.from({ length: 9 }, (_, i) => ({ kind: 'ema', period: 10 + i }));
    const slugs = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const r = mapV2Config({ mas: [{ kind: 'x', period: 5 }, ...mas], strategySlugs: slugs });
    expect(r.items.map((i) => i.inputs.length)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(r.strategySlugs).toHaveLength(20);
  });

  it('kein Objekt → nichts', () => {
    for (const raw of [null, 42, 'x', [], undefined]) expect(mapV2Config(raw)).toEqual({ items: [], strategySlugs: [] });
  });

  it('parseV2Raw: kein Schlüssel → null, kaputtes JSON → leer', () => {
    expect(parseV2Raw(null)).toBeNull();
    expect(parseV2Raw('{kaputt')).toEqual({ items: [], strategySlugs: [] });
    expect(parseV2Raw(JSON.stringify(V2_FULL))?.items).toHaveLength(6);
  });
});

describe('planV2Import: Doppelte überspringen, Obergrenze je Symbol einhalten', () => {
  const items = mapV2Config(V2_FULL).items;

  it('schon vorhandene (gleiche Art + gleiche Perioden) werden nicht doppelt angelegt', () => {
    const existing = [
      { indicatorId: 'ema', inputs: { length: 21, src: 'close', offset: 0, maType: 'None' } },
      // RSI 9 mit Glättungslinie: dieselbe Periode → zählt als vorhanden
      { indicatorId: 'rsi', inputs: { length: 9, src: 'close', maType: 'SMA', maLength: 14 } },
      { indicatorId: 'ema', inputs: { length: 50 } }, // EMA 50 ≠ SMA 50
    ];
    const plan = planV2Import(items, existing, 50);
    expect(plan.add.map((i) => `${i.indicatorId}:${JSON.stringify(i.inputs)}`)).toEqual([
      'sma:{"len":50}',
      'ema:{"length":200}',
      'bb:{"length":30,"mult":2.5}',
      'macd:{"fastLength":8,"slowLength":21,"signalLength":5}',
    ]);
    expect(plan.duplicates).toBe(2);
    expect(plan.overLimit).toBe(0);
  });

  it('Doppelte innerhalb der v2-Liste nur einmal', () => {
    const r = mapV2Config({ mas: [{ kind: 'ema', period: 20 }, { kind: 'ema', period: 20 }] });
    const plan = planV2Import(r.items, [], 50);
    expect(plan.add).toHaveLength(1);
    expect(plan.duplicates).toBe(1);
  });

  it('Obergrenze: nur so viele wie noch frei sind', () => {
    const existing = Array.from({ length: 48 }, (_, i) => ({ indicatorId: 'sma', inputs: { len: 300 + i } }));
    const plan = planV2Import(items, existing, 50);
    expect(plan.add.map((i) => i.indicatorId)).toEqual(['ema', 'sma']);
    expect(plan.overLimit).toBe(4);
  });
});

describe('importV2Indicators: einmalige Übernahme je Symbol', () => {
  const SYMBOL = 'ETH/USDT';
  const deps = (storage: ReturnType<typeof fakeStorage>, over: Partial<ImportDeps> = {}): ImportDeps => ({
    storage,
    existing: [],
    add: vi.fn<ImportDeps['add']>(async () => undefined),
    max: 50,
    ...over,
  });

  it('ohne v2-Schlüssel: nichts tun, keinen Merker setzen', async () => {
    const storage = fakeStorage();
    const d = deps(storage);
    expect(await importV2Indicators(SYMBOL, d)).toBeNull();
    expect(d.add).not.toHaveBeenCalled();
    expect(storage.map.has(v2ImportedKey(SYMBOL))).toBe(false);
  });

  it('schon übernommen: nichts tun', async () => {
    const storage = fakeStorage({ [v2IndicatorKey(SYMBOL)]: JSON.stringify(V2_FULL), [v2ImportedKey(SYMBOL)]: '2026-10-24T00:00:00.000Z' });
    const d = deps(storage);
    expect(await importV2Indicators(SYMBOL, d)).toBeNull();
    expect(d.add).not.toHaveBeenCalled();
  });

  it('legt die Indikatoren der Reihe nach an (Durchschnitte mit eigener Farbe), übernimmt die Strategie-Marker und merkt sich die Übernahme', async () => {
    const storage = fakeStorage({
      [v2IndicatorKey(SYMBOL)]: JSON.stringify(V2_FULL),
      'gladiator.chartStrategyMarkers.ETH/USDT': JSON.stringify(['dsl-trend', 'eigen']),
    });
    const add = vi.fn<ImportDeps['add']>(async () => undefined);
    const existing = [{ indicatorId: 'sma', inputs: { len: 99 }, style: { plots: { plot0: { color: MA_PALETTE[0] } } } }];
    const res = await importV2Indicators(SYMBOL, deps(storage, { add, existing }));
    expect(res).toEqual({ added: 6, duplicates: 0, overLimit: 0, strategySlugs: ['dsl-trend', 'eigen', 'pine-breakout'], markersAdded: 1, failed: null });
    expect(add.mock.calls.map((c) => c[0])).toEqual([
      // Farbe 0 ist auf dem Symbol schon vergeben → 1, 2, 3
      { indicatorId: 'ema', inputs: { length: 21 }, style: { plots: { plot0: { color: MA_PALETTE[1] } } } },
      { indicatorId: 'sma', inputs: { len: 50 }, style: { plots: { plot0: { color: MA_PALETTE[2] } } } },
      { indicatorId: 'ema', inputs: { length: 200 }, style: { plots: { plot0: { color: MA_PALETTE[3] } } } },
      { indicatorId: 'bb', inputs: { length: 30, mult: 2.5 } },
      { indicatorId: 'rsi', inputs: { length: 9, maType: 'None' } },
      { indicatorId: 'macd', inputs: { fastLength: 8, slowLength: 21, signalLength: 5 } },
    ]);
    expect(JSON.parse(storage.getItem('gladiator.chartStrategyMarkers.ETH/USDT')!)).toEqual(['dsl-trend', 'eigen', 'pine-breakout']);
    expect(storage.getItem(v2ImportedKey(SYMBOL))).not.toBeNull();
    // v2-Schlüssel bleibt unangetastet (nichts löschen)
    expect(storage.getItem(v2IndicatorKey(SYMBOL))).toBe(JSON.stringify(V2_FULL));
  });

  it('nichts Neues an Strategie-Markern → strategySlugs null', async () => {
    const storage = fakeStorage({ [v2IndicatorKey(SYMBOL)]: JSON.stringify({ mas: [{ kind: 'ema', period: 21 }] }) });
    const res = await importV2Indicators(SYMBOL, deps(storage));
    expect(res?.strategySlugs).toBeNull();
    expect(res?.markersAdded).toBe(0);
    expect(res?.added).toBe(1);
  });

  it('Obergrenze je Symbol: nur bis zum Limit, Rest gezählt', async () => {
    const storage = fakeStorage({ [v2IndicatorKey(SYMBOL)]: JSON.stringify(V2_FULL) });
    const existing = Array.from({ length: 49 }, (_, i) => ({ indicatorId: 'sma', inputs: { len: 300 + i }, style: null }));
    const add = vi.fn<ImportDeps['add']>(async () => undefined);
    const res = await importV2Indicators(SYMBOL, deps(storage, { add, existing }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ added: 1, overLimit: 5, failed: null });
    expect(storage.getItem(v2ImportedKey(SYMBOL))).not.toBeNull();
  });

  it('Fehler unterwegs: kein Merker — der nächste Aufruf setzt fort, ohne Doppelte', async () => {
    const storage = fakeStorage({ [v2IndicatorKey(SYMBOL)]: JSON.stringify(V2_FULL) });
    let n = 0;
    const flaky = vi.fn<ImportDeps['add']>(async () => {
      n += 1;
      if (n === 3) throw new Error('Server weg');
    });
    const first = await importV2Indicators(SYMBOL, deps(storage, { add: flaky }));
    expect(first).toMatchObject({ added: 2, failed: 'Server weg' });
    expect(storage.getItem(v2ImportedKey(SYMBOL))).toBeNull();

    // zweiter Versuch: die zwei schon angelegten stehen jetzt in der Liste des Servers
    const existing = [
      { indicatorId: 'ema', inputs: { length: 21 }, style: { plots: { plot0: { color: MA_PALETTE[0] } } } },
      { indicatorId: 'sma', inputs: { len: 50 }, style: { plots: { plot0: { color: MA_PALETTE[1] } } } },
    ];
    const add = vi.fn<ImportDeps['add']>(async () => undefined);
    const second = await importV2Indicators(SYMBOL, deps(storage, { add, existing }));
    expect(second).toMatchObject({ added: 4, duplicates: 2, failed: null });
    expect(add.mock.calls[0]?.[0]).toEqual({ indicatorId: 'ema', inputs: { length: 200 }, style: { plots: { plot0: { color: MA_PALETTE[2] } } } });
    expect(storage.getItem(v2ImportedKey(SYMBOL))).not.toBeNull();
  });

  it('leere oder kaputte v2-Konfiguration: nichts anlegen, aber als erledigt merken', async () => {
    const storage = fakeStorage({ [v2IndicatorKey(SYMBOL)]: '{kaputt' });
    const d = deps(storage);
    expect(await importV2Indicators(SYMBOL, d)).toEqual({ added: 0, duplicates: 0, overLimit: 0, strategySlugs: null, markersAdded: 0, failed: null });
    expect(d.add).not.toHaveBeenCalled();
    expect(storage.getItem(v2ImportedKey(SYMBOL))).not.toBeNull();
  });

  it('importV2IndicatorsOnce: zwei Charts mit demselben Symbol gleichzeitig → nur EINE Übernahme', async () => {
    const storage = fakeStorage({ [v2IndicatorKey('SOL/USDT')]: JSON.stringify({ mas: [{ kind: 'ema', period: 21 }] }) });
    const add = vi.fn<ImportDeps['add']>(async () => undefined);
    const [a, b] = await Promise.all([importV2IndicatorsOnce('SOL/USDT', deps(storage, { add })), importV2IndicatorsOnce('SOL/USDT', deps(storage, { add }))]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    // danach ist der Merker gesetzt → kein weiterer Lauf
    expect(await importV2IndicatorsOnce('SOL/USDT', deps(storage, { add }))).toBeNull();
    expect(add).toHaveBeenCalledTimes(1);
  });
});
