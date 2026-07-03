import { describe, expect, it } from 'vitest';
import { renderBriefing, type BriefingData } from './briefing.js';

/** Morning-Briefing (08_ §7): deterministischer Renderer aus ECHTEN Daten — TDD. */

const data: BriefingData = {
  day: '2026-07-04',
  regime: { grs: 43, label: 'neutral', vix: 16.59, dxy: 120.89, us10yPct: 4.48 },
  account: { equity: 10120.5, dailyPnlPct: 0.4, weeklyPnlPct: 1.2, openPositions: 1, consecutiveLosses: 0 },
  yesterday: { closedTrades: 2, netPnl: 85.2, wins: 1 },
  openSignals: [
    { symbol: 'ETH/USDT', timeframe: '4h', direction: 'short', score: 8.2, portfolioVote: 'confirm' },
  ],
  highImpactEventsToday: [{ title: 'Non-Farm Payrolls', currency: 'USD', timeUtc: '12:30' }],
  activeGates: 2,
  killSwitchActive: false,
  news: [{ source: 'coindesk', title: 'ETF-Zuflüsse steigen' }],
  llmInsight: null,
};

describe('renderBriefing', () => {
  it('enthält Regime, Konto, Gestern, Signale, Events und Gates', () => {
    const text = renderBriefing(data);
    expect(text).toMatch(/GRS.*43/);
    expect(text).toMatch(/neutral/);
    expect(text).toMatch(/10\.?12\d/); // 10120.5 $ → de-DE gerundet „10.121"
    expect(text).toMatch(/\+0[.,]40?\s?%/);
    expect(text).toMatch(/Non-Farm Payrolls/);
    expect(text).toMatch(/12:30/);
    expect(text).toMatch(/ETH\/USDT/);
    expect(text).toMatch(/2 aktive Gates|Gates.*2/);
  });

  it('Kill-Switch aktiv → Warnung ganz oben sichtbar', () => {
    const text = renderBriefing({ ...data, killSwitchActive: true });
    expect(text).toMatch(/KILL-SWITCH/);
  });

  it('fehlendes Regime (Daten nicht frisch) → ehrlicher Hinweis statt erfundener Zahlen', () => {
    const text = renderBriefing({ ...data, regime: null });
    expect(text).toMatch(/Makro-Daten nicht verfügbar/i);
    expect(text).not.toMatch(/GRS.*\d/);
  });

  it('keine offenen Signale / Events → ehrliche Leerzeilen', () => {
    const text = renderBriefing({ ...data, openSignals: [], highImpactEventsToday: [] });
    expect(text).toMatch(/keine offenen Signale/i);
    expect(text).toMatch(/keine High-Impact-Events/i);
  });

  it('LLM-Erkenntnis erscheint nur, wenn vorhanden (nie erfunden)', () => {
    expect(renderBriefing(data)).not.toMatch(/KI-Erkenntnis/);
    const withInsight = renderBriefing({ ...data, llmInsight: 'London-Shorts tragen die Woche.' });
    expect(withInsight).toMatch(/KI-Erkenntnis/);
    expect(withInsight).toMatch(/London-Shorts/);
  });
});
