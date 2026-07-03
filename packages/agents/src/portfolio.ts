import type { AgentVerdict, DisabledAgent } from './types.js';

/**
 * Portfolio-Manager (08_ §1) — aggregiert die Einzel-Urteile zu einer
 * finalen Empfehlung. Transparent: gewichtete Abstimmung (confirm +1,
 * caution 0, reject −1, jeweils × Confidence). Harte Regel: ein reject
 * des Risk-Agents ist final (das Gate läuft bei der Order sowieso).
 * Deaktivierte Agenten werden benannt — nie still verschluckt.
 */
export function aggregateVerdicts(verdicts: AgentVerdict[], disabled: DisabledAgent[]): AgentVerdict {
  const disabledNote =
    disabled.length > 0
      ? ` Deaktiviert (ehrlich markiert): ${disabled.map((d) => `${d.agent} (${d.reason})`).join('; ')}.`
      : '';

  if (verdicts.length === 0) {
    return {
      agent: 'portfolio',
      vote: 'caution',
      confidence: 0.2,
      reason: `Keine Agenten-Urteile verfügbar — keine Empfehlung möglich.${disabledNote}`,
      refs: { disabled, votes: [] },
    };
  }

  const riskReject = verdicts.find((v) => v.agent === 'risk' && v.vote === 'reject');
  if (riskReject) {
    return {
      agent: 'portfolio',
      vote: 'reject',
      confidence: 0.95,
      reason: `Risk-Gate lehnt ab (hart): ${riskReject.reason}${disabledNote}`,
      refs: { disabled, votes: summarize(verdicts) },
    };
  }

  const weight = (v: AgentVerdict) => (v.vote === 'confirm' ? 1 : v.vote === 'reject' ? -1 : 0) * v.confidence;
  const totalConfidence = verdicts.reduce((a, v) => a + v.confidence, 0);
  const score = totalConfidence > 0 ? verdicts.reduce((a, v) => a + weight(v), 0) / totalConfidence : 0;

  const vote = score >= 0.35 ? 'confirm' : score <= -0.35 ? 'reject' : 'caution';
  const confidence = Math.min(0.95, Math.max(0.2, Math.abs(score)));
  const counts = {
    confirm: verdicts.filter((v) => v.vote === 'confirm').length,
    caution: verdicts.filter((v) => v.vote === 'caution').length,
    reject: verdicts.filter((v) => v.vote === 'reject').length,
  };

  return {
    agent: 'portfolio',
    vote,
    confidence,
    reason:
      `Gewichtete Abstimmung: ${counts.confirm}× confirm, ${counts.caution}× caution, ${counts.reject}× reject ` +
      `(Score ${score.toFixed(2)}).${disabledNote}`,
    refs: { disabled, votes: summarize(verdicts), score },
  };
}

function summarize(verdicts: AgentVerdict[]) {
  return verdicts.map((v) => ({ agent: v.agent, vote: v.vote, confidence: v.confidence }));
}
