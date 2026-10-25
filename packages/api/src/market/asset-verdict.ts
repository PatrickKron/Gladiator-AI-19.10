import type { Db } from '@gladiator/db';
import { assessAsset, type AssetVerdict, type CostGuard, type LlmProvider } from '@gladiator/agents';
import { buildAssetAnalysis, type AssetAnalysis } from './asset-analysis.js';
import { assetNews } from './asset-news.js';

/**
 * KI-Urteil je Asset (Mängelliste 6, zweite Stufe): Makro-Agent (Oracle) und Shadow-Agent
 * bewerten GENAU die echten Fakten der Asset-Analyse. Gleiche Regel wie im Schwarm: ein Agent
 * läuft nur, wenn seine Datenquelle verbunden ist — sonst ehrlich „nicht verbunden“, kein
 * LLM-Aufruf. Ohne Provider wirft der Router vorher (PRECONDITION_FAILED).
 */
export type AgentOutcome = { agent: 'makro' | 'shadow'; connected: true; verdict: AssetVerdict } | { agent: 'makro' | 'shadow'; connected: false; reason: string } | { agent: 'makro' | 'shadow'; connected: true; error: string };

/** Pur: welche Agenten dürfen laufen (Datenlage), und welche Fakten bekommen sie? */
export function verdictGate(a: AssetAnalysis): { makro: string | null; shadow: string | null } {
  return {
    makro: a.macro.connected ? null : 'Makro-Serien (VIX/DXY/US10Y) nicht verbunden — läuft mit dem nächsten macro-sync.',
    shadow: a.derivatives.connected || a.cot.connected ? null : 'Weder Funding/OI noch COT verbunden — läuft mit dem nächsten derivatives-/cot-sync.',
  };
}

export async function assetVerdicts(db: Db, userId: string, symbol: string, provider: LlmProvider, guard: CostGuard | null, venue = 'binance'): Promise<{ symbol: string; asOf: string; agents: AgentOutcome[]; costUsd: number }> {
  const a = await buildAssetAnalysis(db, userId, symbol, venue);
  const news = await assetNews(db, a.symbol, 6);
  const gate = verdictGate(a);
  const facts = {
    macro: a.macro,
    calendar: a.noTrade,
    derivatives: a.derivatives,
    cot: a.cot,
    news: news.map((n) => ({ source: n.source, publishedAt: n.publishedAt, title: n.title })),
    asOf: a.asOf,
  };
  const agents: AgentOutcome[] = [];
  let costUsd = 0;
  for (const agent of ['makro', 'shadow'] as const) {
    const blocked = gate[agent];
    if (blocked) {
      agents.push({ agent, connected: false, reason: blocked });
      continue;
    }
    try {
      const verdict = await assessAsset(agent, a.symbol, facts, provider, guard);
      costUsd += verdict.costUsd;
      agents.push({ agent, connected: true, verdict });
    } catch (err) {
      agents.push({ agent, connected: true, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { symbol: a.symbol, asOf: a.asOf, agents, costUsd };
}
