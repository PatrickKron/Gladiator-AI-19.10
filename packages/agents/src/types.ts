/**
 * Agenten-Schwarm (08_ §1): strukturierte Urteile, keine Blackbox.
 * Jeder Agent liefert ein AgentVerdict mit nachvollziehbarer Begründung
 * und den Fakten (refs), auf denen das Urteil basiert.
 */

export type AgentVote = 'confirm' | 'reject' | 'caution';

export type AgentVerdict = {
  /** z. B. 'technik', 'risk', 'devil', 'makro', 'shadow', 'portfolio' */
  agent: string;
  vote: AgentVote;
  /** 0..1 — IMMER aus nachvollziehbaren Größen berechnet, nie erfunden. */
  confidence: number;
  reason: string;
  /** Fakten-Basis des Urteils (Checks, Statistiken, Quellen). */
  refs?: Record<string, unknown>;
};

/** Agent, der NICHT laufen kann — sichtbar markiert statt durch Fake ersetzt (08_ §2). */
export type DisabledAgent = {
  agent: string;
  reason: string;
};

/** Fakten eines kanonischen Signals, wie die Agenten sie sehen. */
export type SignalFacts = {
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  setupType: string;
  source: 'engine' | 'pine' | 'instruction' | 'manual' | 'sub_agent';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  score: number;
  confluence: string[];
  session: string;
  emaRegime: 'above' | 'below';
  marketPhase: 'bull' | 'bear';
};

/** Einzelner Check eines Agenten (transparent im UI). */
export type AgentCheck = {
  name: string;
  passed: boolean;
  /** true = harter Fehler (führt zu reject), false = weiche Warnung (caution). */
  hard: boolean;
  detail: string;
};
