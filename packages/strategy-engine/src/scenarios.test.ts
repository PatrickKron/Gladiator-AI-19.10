import { describe, expect, it } from 'vitest';
import {
  evaluateScenarioConfirmation,
  evaluateScenarioTrigger,
  parseScenarioFromText,
  SCENARIO_TEMPLATES,
} from './scenarios.js';
import type { Candle } from './types.js';

function makeCandles(closes: number[], startMs = 1_700_000_000_000): Candle[] {
  return closes.map((c, i) => ({
    ts: new Date(startMs + i * 3_600_000),
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 100,
  }));
}

describe('Szenario-Playbooks / Wenn-Dann-Wetten (Welle 24)', () => {
  it('parst Patricks Pandemie-Beispiel inkl. BOS nach unten, 5x alle Cryptos shorten & Binance-Bestand verkaufen', () => {
    const res = parseScenarioFromText(
      'Pandemie bricht aus dann auf BOS nach unten warten dann Hebel 5x auf alle Cryptos shorten, Bestand auf Wallet Binance verkaufen',
    );
    expect(res.detectedTheme).toMatch(/Pandemie/i);
    expect(res.spec.trigger.kind).toBe('news_keywords');
    expect(res.spec.trigger.keywords).toContain('pandemic');
    expect(res.spec.confirmation.kind).toBe('bos_down');

    const tradeAction = res.spec.actions.find((a) => a.type === 'trade');
    expect(tradeAction).toBeDefined();
    if (tradeAction?.type === 'trade') {
      expect(tradeAction.targetScope).toBe('all_crypto');
      expect(tradeAction.direction).toBe('short');
      expect(tradeAction.leverage).toBe(5);
    }

    const spotAction = res.spec.actions.find((a) => a.type === 'sell_spot_holdings');
    expect(spotAction).toBeDefined();
    if (spotAction?.type === 'sell_spot_holdings') {
      expect(spotAction.venueHint).toBe('binance');
      expect(spotAction.sellPct).toBe(100);
    }

    // Ehrliche Transparenz bei Spot-/Wallet-Verkäufen
    expect(res.feasibility.verdict).toBe('partial');
    expect(res.feasibility.notes.length).toBeGreaterThan(0);
  });

  it('wertet echte News-Meldungen & VIX-Schwellen sauber im Zeitfenster aus', () => {
    const now = new Date('2026-11-23T20:00:00Z');
    const trigger = SCENARIO_TEMPLATES[0]!.spec.trigger;

    const noHit = evaluateScenarioTrigger(trigger, {
      now,
      news: [
        {
          title: 'Bitcoin trades sideways near 90k',
          summary: null,
          source: 'cryptoslate',
          url: 'https://example.com/1',
          publishedAt: new Date('2026-11-23T19:00:00Z'),
        },
      ],
      vix: 18,
      grs: 55,
    });
    expect(noHit.matched).toBe(false);

    const hit = evaluateScenarioTrigger(trigger, {
      now,
      news: [
        {
          title: 'WHO declares new pandemic emergency amid rapid outbreak',
          summary: 'Markets react sharply',
          source: 'reuters',
          url: 'https://example.com/2',
          publishedAt: new Date('2026-11-23T18:30:00Z'),
        },
      ],
      vix: 22,
      grs: 40,
    });
    expect(hit.matched).toBe(true);
    expect(hit.matchedHeadlines).toHaveLength(1);

    // Auch VIX-Schwelle allein löst aus
    const vixHit = evaluateScenarioTrigger(trigger, { now, news: [], vix: 35, grs: 30 });
    expect(vixHit.matched).toBe(true);
  });

  it('erkennt echten BOS nach unten look-ahead-frei auf geschlossenen Kerzen', () => {
    // Aufwärtstrend mit klarem Swing-Low bei 100 (Index 15), dann Bruch nach unten auf 92 am Ende!
    const closes = [
      95, 97, 99, 102, 105, 108, 110, 108, 106, 104,
      102, 101, 100.5, 100.2, 100.1, 100, // Swing-Low bei Index 15
      101, 103, 105, 107, 109, 112, 111, 109, 107, 104, 102, 100.5,
      97, 94, 92, // Klarer Schlusskurs-Bruch unter 100!
    ];
    const candles = makeCandles(closes);

    const conf = evaluateScenarioConfirmation(
      { kind: 'bos_down', symbol: 'BTC/USDT', timeframe: '1h', lookbackBars: 6 },
      candles,
    );
    expect(conf.matched).toBe(true);
    expect(conf.brokenLevel).not.toBeNull();

    // Kein BOS nach oben in diesem Abwärtstrend
    const upConf = evaluateScenarioConfirmation(
      { kind: 'bos_up', symbol: 'BTC/USDT', timeframe: '1h', lookbackBars: 6 },
      candles,
    );
    expect(upConf.matched).toBe(false);

    // Kausalität (Welle 26): lag das Ereignis (News) NACH dem BOS, darf der alte BOS NICHT zählen!
    const lastBarTs = candles[candles.length - 1]!.ts.getTime();
    const afterBosNewsTs = new Date(lastBarTs + 60_000);
    const staleConf = evaluateScenarioConfirmation(
      { kind: 'bos_down', symbol: 'BTC/USDT', timeframe: '1h', lookbackBars: 6 },
      candles,
      'BTC/USDT',
      afterBosNewsTs,
    );
    expect(staleConf.matched).toBe(false);

    // Lag die News VOR dem BOS, zählt der nachfolgende BOS!
    const beforeBosNewsTs = new Date(candles[candles.length - 4]!.ts.getTime());
    const causalConf = evaluateScenarioConfirmation(
      { kind: 'bos_down', symbol: 'BTC/USDT', timeframe: '1h', lookbackBars: 6 },
      candles,
      'BTC/USDT',
      beforeBosNewsTs,
    );
    expect(causalConf.matched).toBe(true);
  });
});
