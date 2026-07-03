import type { RiskVerdict } from '@gladiator/risk';
import type { AgentVerdict } from './types.js';

/**
 * Risk-Agent (neu, 08_ §1) — KEIN eigenes Urteil, sondern die transparente
 * Vorschau der echten Risk-Engine (@gladiator/risk). Das harte Gate läuft
 * ohnehin bei jeder Order; hier wird es dem User VOR der Bestätigung gezeigt.
 */
export function reviewRisk(verdict: RiskVerdict): AgentVerdict {
  const passed = verdict.checks.filter((c) => c.passed).length;
  const total = Math.max(1, verdict.checks.length);

  if (!verdict.allowed) {
    return {
      agent: 'risk',
      vote: 'reject',
      confidence: 0.95, // hartes Gate: das Urteil ist verbindlich, nicht spekulativ
      reason: verdict.reasons.join(' '),
      refs: { checks: verdict.checks, sizing: verdict.sizing },
    };
  }
  return {
    agent: 'risk',
    vote: 'confirm',
    confidence: passed / total,
    reason: 'Alle Risk-Checks bestanden — Order wäre nach aktuellem Kontostand zulässig.',
    refs: { checks: verdict.checks, sizing: verdict.sizing },
  };
}
