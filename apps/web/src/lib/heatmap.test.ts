import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrastRatio, luminance } from './contrast.js';
import {
  HEAT_MAX_ABS,
  HEAT_NEG,
  HEAT_NEUTRAL,
  HEAT_POS,
  CORR_NEG,
  CORR_POS,
  NO_DATA_COLOR,
  TILE_TEXT,
  buildHeatmapGroups,
  changeColor,
  chartTargetFor,
  corrColor,
  matrixLabels,
  meanChange,
  sanitizeSelection,
  shortSymbol,
  sizingVolumes,
  squarify,
  strongestPairs,
  tileLabelMode,
  tileWeights,
  treemapHeight,
  type HeatAsset,
  type HeatQuote,
} from './heatmap.js';

describe('Farbskala Performance (divergierend Rot ↔ Grün, neutraler Mittelpunkt)', () => {
  it('0 % = neutral, ±Skalenende = Pol, darüber gekappt; null = eigene „keine Daten“-Farbe', () => {
    expect(changeColor(0)).toBe(HEAT_NEUTRAL);
    expect(changeColor(HEAT_MAX_ABS)).toBe(HEAT_POS);
    expect(changeColor(-HEAT_MAX_ABS)).toBe(HEAT_NEG);
    expect(changeColor(40)).toBe(HEAT_POS);
    expect(changeColor(-40)).toBe(HEAT_NEG);
    expect(changeColor(null)).toBe(NO_DATA_COLOR);
    expect(changeColor(Number.NaN)).toBe(NO_DATA_COLOR);
  });

  it('Vorzeichen bestimmt die Seite, Betrag die Stärke (monoton zum Pol hin)', () => {
    const dist = (a: string, b: string) => Math.abs(luminance(a) - luminance(b));
    const steps = [0, 1, 2, 3, 4, 5];
    for (const pole of [HEAT_POS, HEAT_NEG]) {
      const sign = pole === HEAT_POS ? 1 : -1;
      const d = steps.map((s) => dist(changeColor(sign * s), pole));
      for (let i = 1; i < d.length; i++) expect(d[i]!).toBeLessThanOrEqual(d[i - 1]! + 1e-9);
    }
    expect(changeColor(1.5)).not.toBe(changeColor(-1.5));
  });

  it('Kachel-Schrift (weiß) bleibt auf JEDER Stufe lesbar (WCAG AA 4,5:1)', () => {
    for (let p = -6; p <= 6; p += 0.25) expect(contrastRatio(TILE_TEXT, changeColor(p)), `bei ${p} %`).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(TILE_TEXT, NO_DATA_COLOR)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('Farbskala Korrelation (Blau = gleichläufig, Rot = gegenläufig)', () => {
  it('−1 / 0 / +1 und null', () => {
    expect(corrColor(1)).toBe(CORR_POS);
    expect(corrColor(-1)).toBe(CORR_NEG);
    expect(corrColor(0)).toBe(HEAT_NEUTRAL);
    expect(corrColor(null)).toBe(NO_DATA_COLOR);
  });
  it('Zellen-Schrift lesbar auf jeder Stufe', () => {
    for (let r = -1; r <= 1; r += 0.1) expect(contrastRatio(TILE_TEXT, corrColor(r))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('Kachelgröße nur aus echtem Gewicht', () => {
  it('ohne jedes Gewicht: alle gleich groß (nie erfundene Marktkapitalisierung)', () => {
    expect(tileWeights([null, null, null])).toEqual({ weights: [1, 1, 1], weighted: false });
    expect(tileWeights([])).toEqual({ weights: [], weighted: false });
  });

  it('mit Volumen: Reihenfolge bleibt, Fläche ∝ √Volumen; fehlendes Volumen → Mindestgröße', () => {
    const { weights, weighted } = tileWeights([10_000, 2_500, null, 100]);
    expect(weighted).toBe(true);
    // √: 100, 50, –, 10 → Mittel 53,3 → Mindestgröße 0,5·53,3 = 26,67
    expect(weights[0]).toBeCloseTo(100, 6);
    expect(weights[1]).toBeCloseTo(50, 6);
    expect(weights[2]).toBeCloseTo((0.5 * 160) / 3, 6);
    expect(weights[3]).toBeCloseTo((0.5 * 160) / 3, 6); // 10 < Mindestgröße → angehoben
  });
});

describe('sizingVolumes: Gewicht nur in reinen Krypto-Gruppen', () => {
  it('reine Krypto-Gruppe nutzt Volumen, gemischte Gruppe (Paket) nicht — Aktien sähen sonst grundlos klein aus', () => {
    expect(sizingVolumes([{ assetType: 'CRYPTO', volume: 5 }, { assetType: 'crypto', volume: null }])).toEqual([5, null]);
    expect(sizingVolumes([{ assetType: 'CRYPTO', volume: 5 }, { assetType: 'STOCK', volume: null }])).toEqual([null, null]);
    expect(sizingVolumes([])).toEqual([]);
  });
});

describe('squarify (Treemap-Aufteilung)', () => {
  const area = (r: { w: number; h: number }) => r.w * r.h;

  it('Flächen proportional zum Gewicht, alles innerhalb, Gesamtfläche erhalten', () => {
    const weights = [6, 6, 4, 3, 2, 2, 1];
    const rects = squarify(weights, 600, 400);
    expect(rects).toHaveLength(weights.length);
    const total = weights.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => {
      expect(area(r)).toBeCloseTo((weights[i]! / total) * 600 * 400, 4);
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-6);
    });
    expect(rects.reduce((a, r) => a + area(r), 0)).toBeCloseTo(600 * 400, 4);
  });

  it('keine Überlappung', () => {
    const rects = squarify([5, 1, 3, 3, 2, 8, 1, 1], 500, 300);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox <= 1e-6 || oy <= 1e-6, `Rechteck ${i} überlappt ${j}`).toBe(true);
      }
  });

  it('gleiche Gewichte → gleich große, annähernd quadratische Kacheln', () => {
    const rects = squarify([1, 1, 1, 1], 200, 200);
    for (const r of rects) {
      expect(r.w).toBeCloseTo(100, 6);
      expect(r.h).toBeCloseTo(100, 6);
    }
  });

  it('Randfälle: leer, Breite 0, Gewichte 0 → gleich verteilt statt NaN', () => {
    expect(squarify([], 100, 100)).toEqual([]);
    expect(squarify([1, 2], 0, 100).every((r) => r.w === 0 && r.h === 0)).toBe(true);
    const z = squarify([0, 0], 100, 50);
    expect(z.every((r) => Number.isFinite(r.w) && Number.isFinite(r.h))).toBe(true);
    expect(area(z[0]!)).toBeCloseTo(2500, 6);
  });
});

describe('Layout-Helfer', () => {
  it('treemapHeight wächst mit der Kachelzahl, mindestens 120 px, schmaler Bildschirm → höher', () => {
    expect(treemapHeight(1000, 100)).toBe(420);
    expect(treemapHeight(360, 100)).toBe(1167);
    expect(treemapHeight(1000, 2)).toBe(120);
    expect(treemapHeight(0, 10)).toBe(120);
  });
  it('tileLabelMode: Ticker + %, nur Ticker oder nichts (dann Tooltip/aria-label)', () => {
    expect(tileLabelMode(80, 50)).toBe('full');
    expect(tileLabelMode(40, 24)).toBe('ticker');
    expect(tileLabelMode(20, 40)).toBe('none');
  });
  it('matrixLabels: kurz und eindeutig (gleiches Kürzel auf zwei Venues bekommt die Venue)', () => {
    expect(
      matrixLabels([
        { symbol: 'BTC/USDT', venue: 'binance' },
        { symbol: 'AAPL', venue: 'yahoo' },
        { symbol: 'AAPL', venue: 'twelvedata' },
      ]),
    ).toEqual(['BTC', 'AAPL·yahoo', 'AAPL·twelvedata']);
  });
  it('120 Krypto-Kacheln (Volumen über vier Größenordnungen): auf Handy und Desktop zeigt jede mindestens den Ticker', () => {
    const vols = Array.from({ length: 120 }, (_, i) => 2e9 * Math.pow(0.93, i));
    for (const width of [358, 1100]) {
      const rects = squarify(tileWeights(vols).weights, width, treemapHeight(width, vols.length));
      const modes = rects.map((r) => tileLabelMode(r.w - 2, r.h - 2));
      expect(modes.filter((m) => m === 'none'), `bei ${width} px`).toEqual([]);
      expect(modes.filter((m) => m === 'full').length).toBeGreaterThan(30);
    }
  });
  it('shortSymbol: BTC/USDT → BTC, Aktien bleiben', () => {
    expect(shortSymbol('BTC/USDT', 'binance')).toBe('BTC');
    expect(shortSymbol('ETH/USDC', 'binance')).toBe('ETH/USDC');
    expect(shortSymbol('AAPL', 'yahoo')).toBe('AAPL');
  });
});

describe('buildHeatmapGroups: Klassen/Pakete, Live-Ticks, ehrlich ohne Kurs', () => {
  const assets: HeatAsset[] = [
    { id: 1, ticker: 'BTC', name: 'Bitcoin', assetType: 'CRYPTO', symbol: 'BTC/USDT', isFavorite: true },
    { id: 2, ticker: 'ETH', name: 'Ethereum', assetType: 'CRYPTO', symbol: 'ETH/USDT', isFavorite: false },
    { id: 3, ticker: 'AAPL', name: 'Apple', assetType: 'STOCK', symbol: null, isFavorite: true },
    { id: 4, ticker: 'MSFT', name: 'Microsoft', assetType: 'STOCK', symbol: null, isFavorite: false },
    { id: 5, ticker: 'SPY', name: 'SPDR S&P 500', assetType: 'ETF', symbol: null, isFavorite: false },
    { id: 6, ticker: 'WEIRD', name: 'Unbekannt', assetType: 'BOND', symbol: null, isFavorite: false },
  ];
  const q = (ticker: string, price: number, changePct: number | null, source: HeatQuote['source'], quoteVolume24h: number | null = null): HeatQuote => ({
    ticker,
    price,
    changePct,
    currency: 'USD',
    quoteVolume24h,
    source,
    ts: '2026-10-25T10:00:00.000Z',
  });
  const quotes: Record<string, HeatQuote | null> = {
    BTC: q('BTC', 61000, -1.2, 'binance', 2e9),
    ETH: q('ETH', 2400, 0.8, 'binance', 1e9),
    AAPL: q('AAPL', 230, 0.4, 'tradingview'),
    MSFT: null,
    SPY: q('SPY', 580, null, 'tradingview'),
    WEIRD: q('WEIRD', 1, 2, 'tradingview'),
  };

  it('nach Klasse in fester Reihenfolge, unbekannte Klasse am Ende; Assets ohne Kurs separat gezählt', () => {
    const res = buildHeatmapGroups(assets, quotes, new Map(), { filter: 'all', groupBy: 'class' });
    expect(res.groups.map((g) => g.key)).toEqual(['CRYPTO', 'STOCK', 'ETF', 'BOND']);
    expect(res.groups[0]!.tiles.map((t) => t.ticker)).toEqual(['BTC', 'ETH']);
    expect(res.missing.map((m) => m.ticker)).toEqual(['MSFT']);
    // SPY hat Kurs, aber keine Änderung → Kachel bleibt (grau), nicht „ohne Kurs“
    expect(res.groups[2]!.tiles[0]).toMatchObject({ ticker: 'SPY', changePct: null });
  });

  it('Live-Tick (SSE) übersteuert Kurs und 24h-Änderung, Quelle „live“; Volumen bleibt aus dem REST-Quote', () => {
    const live = new Map([['BTC/USDT', { price: 61500, changePct: -0.5, ts: '2026-10-25T10:00:05.000Z' }]]);
    const res = buildHeatmapGroups(assets, quotes, live, { filter: 'CRYPTO', groupBy: 'class' });
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]!.tiles[0]).toMatchObject({ ticker: 'BTC', price: 61500, changePct: -0.5, source: 'live', ts: '2026-10-25T10:00:05.000Z', volume: 2e9 });
  });

  it('Live-Tick ohne Kurs-Abfrage zählt als Kurs (Krypto bleibt sichtbar, auch wenn REST ausfällt)', () => {
    const live = new Map([['ETH/USDT', { price: 2410, changePct: null, ts: '2026-10-25T10:00:05.000Z' }]]);
    const res = buildHeatmapGroups(assets, { ...quotes, ETH: null }, live, { filter: 'CRYPTO', groupBy: 'class' });
    expect(res.groups[0]!.tiles.find((t) => t.ticker === 'ETH')).toMatchObject({ price: 2410, changePct: null, source: 'live', volume: null });
  });

  it('Favoriten-Filter und Klassen-Filter', () => {
    const fav = buildHeatmapGroups(assets, quotes, new Map(), { filter: 'favorites', groupBy: 'class' });
    expect(fav.groups.flatMap((g) => g.tiles.map((t) => t.ticker))).toEqual(['BTC', 'AAPL']);
    const stock = buildHeatmapGroups(assets, quotes, new Map(), { filter: 'STOCK', groupBy: 'class' });
    expect(stock.groups.map((g) => g.key)).toEqual(['STOCK']);
    expect(stock.missing.map((m) => m.ticker)).toEqual(['MSFT']);
  });

  it('nach Paket in Paket-Reihenfolge; ohne Paket-Zuordnung eigene Gruppe am Ende', () => {
    const packageOf = new Map([
      [1, 10],
      [2, 10],
      [3, 20],
      [5, 20],
    ]);
    const res = buildHeatmapGroups(assets, quotes, new Map(), {
      filter: 'all',
      groupBy: 'package',
      packages: [
        { id: 20, name: 'US Tech' },
        { id: 10, name: 'Krypto Kern' },
      ],
      packageOf,
    });
    expect(res.groups.map((g) => g.label ?? g.key)).toEqual(['US Tech', 'Krypto Kern', '__none__']);
    expect(res.groups[2]!.tiles.map((t) => t.ticker)).toEqual(['WEIRD']);
  });

  it('meanChange: Mittel der echten Änderungen, null ohne eine', () => {
    const res = buildHeatmapGroups(assets, quotes, new Map(), { filter: 'all', groupBy: 'class' });
    expect(meanChange(res.groups[0]!.tiles)).toBeCloseTo(-0.2, 10);
    expect(meanChange(res.groups[2]!.tiles)).toBeNull();
  });
});

describe('chartTargetFor: Klick → Chart mit der richtigen Kerzenquelle', () => {
  const venues = new Map([['AAPL', 'yahoo']]);
  it('Krypto → Binance-Chart (Tageskerzen), Aktie mit DB-Kerzen → Yahoo/Twelve Data, sonst kein Sprung', () => {
    expect(chartTargetFor({ assetType: 'CRYPTO', symbol: 'BTC/USDT', ticker: 'BTC' }, venues)).toBe('#/charts?symbol=BTC%2FUSDT&tf=1d');
    expect(chartTargetFor({ assetType: 'STOCK', symbol: null, ticker: 'AAPL' }, venues)).toBe('#/charts?symbol=AAPL&tf=1d&venue=yahoo');
    expect(chartTargetFor({ assetType: 'STOCK', symbol: null, ticker: 'NVDA' }, venues)).toBeNull();
    expect(chartTargetFor({ assetType: 'CRYPTO', symbol: null, ticker: 'AKT' }, venues)).toBeNull();
  });
});

describe('strongestPairs / sanitizeSelection', () => {
  it('stärkste gleich- und gegenläufige Paare ohne Diagonale, ohne Doppelte, null übersprungen', () => {
    const symbols = ['A', 'B', 'C', 'D'];
    const m = [
      [1, 0.9, -0.4, null],
      [0.9, 1, 0.1, -0.7],
      [-0.4, 0.1, 1, 0.3],
      [null, -0.7, 0.3, 1],
    ];
    const res = strongestPairs(symbols, m, 2);
    expect(res.top.map((p) => `${p.a}-${p.b}:${p.r}`)).toEqual(['A-B:0.9', 'C-D:0.3']);
    expect(res.bottom.map((p) => `${p.a}-${p.b}:${p.r}`)).toEqual(['B-D:-0.7', 'A-C:-0.4']);
  });

  it('gespeicherte Auswahl: nur Symbole, die (noch) Kerzen haben, ohne Doppelte, gedeckelt; Müll → null', () => {
    const universe = [
      { symbol: 'BTC/USDT', venue: 'binance', candles: 700 },
      { symbol: 'AAPL', venue: 'yahoo', candles: 1200 },
    ];
    expect(
      sanitizeSelection(
        JSON.stringify([
          { symbol: 'AAPL', venue: 'yahoo' },
          { symbol: 'GONE/USDT', venue: 'binance' },
          { symbol: 'AAPL', venue: 'yahoo' },
          { symbol: 'BTC/USDT', venue: 'binance' },
        ]),
        universe,
        20,
      ),
    ).toEqual([
      { symbol: 'AAPL', venue: 'yahoo' },
      { symbol: 'BTC/USDT', venue: 'binance' },
    ]);
    expect(sanitizeSelection('kaputt{', universe, 20)).toBeNull();
    expect(sanitizeSelection(null, universe, 20)).toBeNull();
    expect(sanitizeSelection(JSON.stringify([{ symbol: 'BTC/USDT', venue: 'binance' }, { symbol: 'AAPL', venue: 'yahoo' }]), universe, 1)).toHaveLength(1);
  });
});
