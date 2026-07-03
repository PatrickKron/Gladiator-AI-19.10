/**
 * Risk-Engine (Phase 4a) — hartes Gate VOR jeder Order (06_ §6, 10_ §5a).
 * Reine, deterministische Funktion: gleiche Eingaben ⇒ gleiches Urteil.
 * Führt selbst NICHTS aus — sie urteilt nur (Agenten/Order-Router müssen
 * durch dieses Gate, Ausführung kommt in 4b).
 *
 * Zwei Schichten:
 * 1. STATISCHE Gates: Limits aus trading_settings + SAFE-Kill-Switches.
 * 2. ADAPTIVE Gates (Selbst-Kalibrierung): evidenzbasierte, restriktive
 *    Regeln aus echten Trade-Statistiken (calibration.ts). Sie können nur
 *    VERSCHÄRFEN — niemals statische Limits lockern (Mensch im Loop).
 */

export type OrderIntent = {
  symbol: string;
  timeframe?: string;
  direction: 'long' | 'short';
  entry: number;
  stopLoss: number;
  leverage: number;
  session: string;
  emaRegime: 'above' | 'below';
  marketPhase: 'bull' | 'bear';
};

export type RiskSettings = {
  riskPctPerTrade: number;
  maxLeverage: number;
  maxOpenPositions: number;
  maxExposurePctPerAsset: number;
  dailyLossLimitPct: number;   // SAFE-001
  weeklyLossLimitPct: number;  // SAFE-001
  monthlyLossLimitPct: number; // SAFE-001
  maxConsecutiveLosses: number;      // SAFE-002
  pauseAfterLossStreakHours: number; // SAFE-002
  killSwitchActive: boolean;
};

export type AccountState = {
  equity: number;
  availableMargin: number;
  openPositions: number;
  exposureBySymbolPct: Record<string, number>;
  dailyPnlPct: number;
  weeklyPnlPct: number;
  monthlyPnlPct: number;
  consecutiveLosses: number;
  lastLossAt: Date | null;
  now: Date;
};

export type MarketLimits = {
  tickSize: number;
  lotSize: number;
  minNotional: number;
};

export type AdaptiveGate = {
  kind: 'block';
  direction?: 'long' | 'short';
  emaRegime?: 'above' | 'below';
  session?: string;
  marketPhase?: 'bull' | 'bear';
  symbol?: string;
  timeframe?: string;
  reason: string;
  evidence: { trades: number; expectancyR: number; winRate: number };
};

export type RiskCheck = { name: string; passed: boolean; detail: string };

export type RiskVerdict = {
  allowed: boolean;
  reasons: string[];
  checks: RiskCheck[];
  sizing: { qty: number; notional: number; marginRequired: number; riskAmount: number } | null;
};

function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step + 1e-9) * step;
}

/** Prüft, ob ein adaptives Gate auf die Order passt (alle GESETZTEN Kriterien müssen matchen). */
export function gateMatches(gate: AdaptiveGate, order: OrderIntent): boolean {
  if (gate.direction !== undefined && gate.direction !== order.direction) return false;
  if (gate.emaRegime !== undefined && gate.emaRegime !== order.emaRegime) return false;
  if (gate.session !== undefined && gate.session !== order.session) return false;
  if (gate.marketPhase !== undefined && gate.marketPhase !== order.marketPhase) return false;
  if (gate.symbol !== undefined && gate.symbol !== order.symbol) return false;
  if (gate.timeframe !== undefined && gate.timeframe !== order.timeframe) return false;
  return true;
}

export type RiskContext = {
  /** Aktives No-Trade-Fenster (High-Impact-Makro-Event) — blockt neue Orders. */
  noTrade?: { active: boolean; reason: string } | null;
};

export function evaluateRisk(
  order: OrderIntent,
  settings: RiskSettings,
  state: AccountState,
  market: MarketLimits,
  adaptiveGates: AdaptiveGate[],
  context: RiskContext = {},
): RiskVerdict {
  const checks: RiskCheck[] = [];
  const reasons: string[] = [];
  const fail = (name: string, detail: string) => {
    checks.push({ name, passed: false, detail });
    reasons.push(detail);
  };
  const pass = (name: string, detail: string) => checks.push({ name, passed: true, detail });

  // ── 1. Kill-Switch ──
  if (settings.killSwitchActive) fail('kill-switch', 'Kill-Switch ist aktiv — keine neuen Orders.');
  else pass('kill-switch', 'inaktiv');

  // ── 1b. No-Trade-Fenster (High-Impact-Makro-Event, 09_ §3.7) ──
  if (context.noTrade?.active) {
    fail('no-trade-window', `No-Trade-Fenster aktiv: ${context.noTrade.reason} — keine neuen Orders rund um High-Impact-Events.`);
  } else pass('no-trade-window', 'kein High-Impact-Event im Fenster');

  // ── 2. SAFE-001: Verlustlimits Tag/Woche/Monat ──
  if (state.dailyPnlPct <= -settings.dailyLossLimitPct) {
    fail('safe-001-daily', `SAFE-001: Tagesverlust ${state.dailyPnlPct.toFixed(2)} % ≤ −${settings.dailyLossLimitPct} % — HALT (manueller Reset).`);
  } else pass('safe-001-daily', `Tages-PnL ${state.dailyPnlPct.toFixed(2)} %`);
  if (state.weeklyPnlPct <= -settings.weeklyLossLimitPct) {
    fail('safe-001-weekly', `SAFE-001: Wochenverlust ${state.weeklyPnlPct.toFixed(2)} % ≤ −${settings.weeklyLossLimitPct} % — HALT.`);
  } else pass('safe-001-weekly', `Wochen-PnL ${state.weeklyPnlPct.toFixed(2)} %`);
  if (state.monthlyPnlPct <= -settings.monthlyLossLimitPct) {
    fail('safe-001-monthly', `SAFE-001: Monatsverlust ${state.monthlyPnlPct.toFixed(2)} % ≤ −${settings.monthlyLossLimitPct} % — HALT.`);
  } else pass('safe-001-monthly', `Monats-PnL ${state.monthlyPnlPct.toFixed(2)} %`);

  // ── 3. SAFE-002: Verlustserie → Pause ──
  if (state.consecutiveLosses >= settings.maxConsecutiveLosses && state.lastLossAt !== null) {
    const pauseUntil = new Date(state.lastLossAt.getTime() + settings.pauseAfterLossStreakHours * 3_600_000);
    if (state.now < pauseUntil) {
      fail('safe-002-streak', `SAFE-002: ${state.consecutiveLosses} Verluste in Folge — Pause bis ${pauseUntil.toISOString()}.`);
    } else pass('safe-002-streak', 'Pause abgelaufen');
  } else pass('safe-002-streak', `${state.consecutiveLosses} Verluste in Folge`);

  // ── 4. Hebel-Cap ──
  if (order.leverage > settings.maxLeverage) {
    fail('leverage', `Hebel ${order.leverage}× über Cap ${settings.maxLeverage}×.`);
  } else pass('leverage', `${order.leverage}× ≤ ${settings.maxLeverage}×`);

  // ── 5. Max. offene Positionen ──
  if (state.openPositions >= settings.maxOpenPositions) {
    fail('positions', `Max. offene Positionen erreicht (${state.openPositions}/${settings.maxOpenPositions}).`);
  } else pass('positions', `${state.openPositions}/${settings.maxOpenPositions}`);

  // ── 6. Adaptive Gates (Selbst-Kalibrierung — nur restriktiv) ──
  const hit = adaptiveGates.find((g) => gateMatches(g, order));
  if (hit) {
    fail('adaptive-gates', `Adaptives Gate: ${hit.reason} (Evidenz: ${hit.evidence.trades} Trades, Expectancy ${hit.evidence.expectancyR.toFixed(2)} R).`);
  } else pass('adaptive-gates', `${adaptiveGates.length} Gate(s) geprüft, keins greift`);

  // ── 7. Sizing (exakt: Risiko% ÷ SL-Abstand, Lot-Rundung, Min-Notional) ──
  const slValid = order.direction === 'long' ? order.stopLoss < order.entry : order.stopLoss > order.entry;
  let sizing: RiskVerdict['sizing'] = null;
  if (!slValid) {
    fail('sizing', 'Stop-Loss liegt auf der falschen Seite des Entry.');
    pass('margin', 'übersprungen (kein Sizing)');
    pass('exposure', 'übersprungen (kein Sizing)');
  } else {
    const riskAmount = state.equity * (settings.riskPctPerTrade / 100);
    const riskDistance = Math.abs(order.entry - order.stopLoss);
    const rawQty = riskAmount / riskDistance;
    const qty = roundDownToStep(rawQty, market.lotSize);
    const notional = qty * order.entry;

    if (qty <= 0 || notional < market.minNotional) {
      fail('sizing', `Order unter Mindest-Notional (${notional.toFixed(2)} < ${market.minNotional}).`);
      pass('margin', 'übersprungen (kein Sizing)');
      pass('exposure', 'übersprungen (kein Sizing)');
    } else {
      sizing = { qty, notional, marginRequired: notional / order.leverage, riskAmount };
      pass('sizing', `qty ${qty}, Notional ${notional.toFixed(2)}`);

      // ── 8. Margin-Check ──
      if (sizing.marginRequired > state.availableMargin) {
        fail('margin', `Margin reicht nicht (${sizing.marginRequired.toFixed(2)} > ${state.availableMargin.toFixed(2)}).`);
      } else pass('margin', `${sizing.marginRequired.toFixed(2)} ≤ ${state.availableMargin.toFixed(2)}`);

      // ── 9. Exposure je Asset ──
      const existing = state.exposureBySymbolPct[order.symbol] ?? 0;
      const addedPct = state.equity > 0 ? (notional / state.equity) * 100 : Infinity;
      if (existing + addedPct > settings.maxExposurePctPerAsset) {
        fail('exposure', `Exposure ${order.symbol}: ${(existing + addedPct).toFixed(1)} % > Limit ${settings.maxExposurePctPerAsset} %.`);
      } else pass('exposure', `${(existing + addedPct).toFixed(1)} % ≤ ${settings.maxExposurePctPerAsset} %`);
    }
  }

  const allowed = reasons.length === 0;
  return { allowed, reasons, checks, sizing: allowed ? sizing : sizing };
}
