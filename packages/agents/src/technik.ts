import type { AgentCheck, AgentVerdict, SignalFacts } from './types.js';

/**
 * Technik-Agent (Erbe: Block Sentinel) — validiert das technische Setup
 * DETERMINISTISCH aus den echten Signal-Fakten: Konsistenz, RR, Regime-
 * Alignment, Score/Confluence. Kein LLM nötig; Confidence = Anteil
 * bestandener Checks (nachvollziehbar, nie erfunden).
 */
export function reviewTechnik(f: SignalFacts): AgentVerdict {
  const checks: AgentCheck[] = [];
  const risk = f.direction === 'long' ? f.entry - f.stopLoss : f.stopLoss - f.entry;
  const tp1 = f.takeProfits[0];

  // 1. Konsistenz: SL auf der richtigen Seite, TP in Trade-Richtung
  const slOk = risk > 0;
  const tpOk =
    tp1 !== undefined && (f.direction === 'long' ? tp1 > f.entry : tp1 < f.entry);
  checks.push({
    name: 'konsistenz',
    passed: slOk && tpOk,
    hard: true,
    detail:
      slOk && tpOk
        ? 'Stop und Take-Profits liegen auf der richtigen Seite.'
        : 'Setup inkonsistent: Stop-Loss/Take-Profit liegen auf der falschen Seite des Entrys.',
  });

  // 2. RR zum ersten TP (netto-relevanteste Größe des Setups)
  const rr1 = slOk && tp1 !== undefined ? Math.abs(tp1 - f.entry) / risk : 0;
  if (slOk && tpOk) {
    checks.push({
      name: 'rr-tp1',
      passed: rr1 >= 1,
      hard: true,
      detail: rr1 >= 1 ? `RR zum TP1 = ${rr1.toFixed(2)}.` : `RR zum TP1 nur ${rr1.toFixed(2)} (< 1) — Risiko übersteigt Reward.`,
    });
    checks.push({
      name: 'rr-qualitaet',
      passed: rr1 >= 1.5,
      hard: false,
      detail: rr1 >= 1.5 ? `RR ${rr1.toFixed(2)} ≥ 1.5.` : `RR ${rr1.toFixed(2)} ist knapp (1..1.5).`,
    });
  }

  // 3. Regime-Alignment: Gegentrend-Trades sind die historisch schwächsten
  const aligned =
    (f.direction === 'long' && f.emaRegime === 'above') ||
    (f.direction === 'short' && f.emaRegime === 'below');
  checks.push({
    name: 'ema-regime',
    passed: aligned,
    hard: false,
    detail: aligned
      ? `Richtung passt zum EMA200-Regime (${f.emaRegime}).`
      : `Gegentrend: ${f.direction} bei Preis ${f.emaRegime === 'below' ? 'unter' : 'über'} EMA200.`,
  });

  // 4. Score/Confluence (bei externen Quellen ist der Score RR-basiert — milder prüfen)
  const scoreFloor = f.source === 'engine' ? 6 : 4;
  checks.push({
    name: 'score',
    passed: f.score >= scoreFloor,
    hard: false,
    detail: `Score ${f.score.toFixed(1)} (Quelle ${f.source}, Untergrenze ${scoreFloor}).`,
  });

  const hardFails = checks.filter((c) => c.hard && !c.passed);
  const softFails = checks.filter((c) => !c.hard && !c.passed);
  const passedShare = checks.filter((c) => c.passed).length / checks.length;

  if (hardFails.length > 0) {
    return {
      agent: 'technik',
      vote: 'reject',
      confidence: 0.95,
      reason: hardFails.map((c) => c.detail).join(' '),
      refs: { checks, rr1 },
    };
  }
  if (softFails.length > 0) {
    return {
      agent: 'technik',
      vote: 'caution',
      confidence: passedShare,
      reason: softFails.map((c) => c.detail).join(' '),
      refs: { checks, rr1 },
    };
  }
  return {
    agent: 'technik',
    vote: 'confirm',
    confidence: passedShare,
    reason: `Setup technisch sauber: RR ${rr1.toFixed(2)}, Regime-Alignment, Score ${f.score.toFixed(1)}.`,
    refs: { checks, rr1 },
  };
}
