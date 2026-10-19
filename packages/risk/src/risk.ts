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

import {
  SAFE_003_BTC_INTRADAY_MAX_PCT,
  SAFE_003_ETH_INTRADAY_MAX_PCT,
  SAFE_004_MAX_LATENCY_MS,
  SAFE_005_MAX_ZSCORE,
  SAFE_005_STALE_TOLERANCE_MS,
  SAFE_006_MAX_AVG_SLIPPAGE_PCT,
  SAFE_006_MAX_SINGLE_SLIPPAGE_PCT,
  SAFE_007_MAX_REGIME_CHANGES_24H,
  SAFE_007_SIZE_FACTOR,
  SAFE_008_MAX_ORDERS_PER_MIN,
  SAFE_008_PRICE_COLLAR_PCT,
  SAFE_010_MAX_OPEN_ORDERS_PER_ASSET,
  SAFE_010_OPPOSITE_COOLDOWN_MS,
} from './safe.js';

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
  /**
   * Vom User GEWÜNSCHTER Einsatz (Positionswert in Kontowährung) — Patricks
   * „ich kann die Höhe nicht setzen"-Fix. Fehlt er, rechnet das Sizing wie
   * bisher aus Risiko% ÷ SL-Abstand. Alle HARTEN Checks (Hebel-Cap, Margin,
   * Exposure, Min-Notional, SAFE-Gates) gelten unverändert auch für den
   * Wunsch-Betrag — der User bestimmt die Größe, das Gate bleibt maßgeblich.
   */
  requestedNotional?: number;
  /**
   * Ordertyp des Entries (Default 'market' — so platziert der Executor heute).
   * SAFE-006 lässt bei schlechter Slippage-Historie nur noch Limit-Orders zu.
   */
  orderType?: 'market' | 'limit';
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

/**
 * Ein protokollierter Check. `skipped` = Eingangsdaten fehlten — der Check
 * konnte NICHT bewertet werden (ehrlich markiert, nie mit erfundenen Werten).
 */
export type RiskCheck = { name: string; passed: boolean; detail: string; skipped?: boolean };

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
  /** Aktueller VIX (echte Serie) für SAFE-003; null = Daten nicht verfügbar (ehrlich, keine Blockade). */
  vix?: number | null;

  // ── Ab hier: SAFE-003…010 (10_ §5a/§5b). Konvention für ALLE Felder:
  //    undefined = vom Aufrufer nicht erhoben (z. B. Vorschau) → „übersprungen (Daten fehlen)";
  //    null      = erhoben, aber keine Daten vorhanden → je Regel (meist übersprungen,
  //                beim Live-Preis/Price-Collar HARTER Block).

  /** SAFE-003: größte Intraday-Auslenkung (% vom UTC-Tages-Open) von BTC/ETH. */
  majorsIntradayMovePct?: { btc: number | null; eth: number | null };
  /** SAFE-004: gemessene Latenz der Live-Preis-Abfrage direkt vor der Order (ms). */
  priceLatencyMs?: number | null;
  /**
   * SAFE-005: Frische der Kerzen des Signal-Timeframes. `expectedMaxAgeMs` =
   * Höchstalter, das die Ingest-Pipeline regulär erreicht (vom Aufrufer, der die
   * Pipeline kennt); stale = älter als das + 5 min. null = keine Kerzen in der DB.
   */
  marketData?: { lastCandleTs: Date; expectedMaxAgeMs: number } | null;
  /** SAFE-005: Z-Score der Live-Rendite vs. Kerzen-Historie (null = zu wenig Historie). */
  priceZScore?: number | null;
  /** SAFE-006: Slippage (%, absolut) der Entry-Fills im 24-h-Fenster. [] = keine Fills. */
  recentSlippagePct?: number[];
  /** SAFE-007: Anzahl Regime-Wechsel (Symbol/Timeframe) in 24 h; null = keine Regime-Daten. */
  regimeChanges24h?: number | null;
  /** SAFE-008: echter Live-Mark-Preis des Symbols; null = Abruf fehlgeschlagen ⇒ Block. */
  markPrice?: number | null;
  /** SAFE-008: risiko-eröffnende (nicht reduce-only) Orders des Users in den letzten 60 s. */
  entryOrdersLastMinute?: number;
  /** SAFE-010: offene, nicht reduce-only Orders des Users auf diesem Symbol. */
  openEntryOrdersOnSymbol?: number;
  /** SAFE-010: Zeitpunkt des letzten geschlossenen Trades in GEGENrichtung auf diesem Symbol; null = keiner. */
  lastOppositeCloseAt?: Date | null;
};

/** SAFE-003-Schwelle (10_ §5a): VIX > 40 ⇒ keine neuen Positionen. */
export const SAFE_003_VIX_MAX = 40;

const SKIPPED = 'übersprungen (Daten fehlen)';

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
  /** Daten fehlen → Check nicht bewertbar; sichtbar markiert, blockt nicht. */
  const skip = (name: string, detail: string) => checks.push({ name, passed: true, skipped: true, detail: `${SKIPPED}: ${detail}` });

  // ── 1. Kill-Switch ──
  if (settings.killSwitchActive) fail('kill-switch', 'Kill-Switch ist aktiv — keine neuen Orders.');
  else pass('kill-switch', 'inaktiv');

  // ── 1b. No-Trade-Fenster (High-Impact-Makro-Event, 09_ §3.7) ──
  if (context.noTrade?.active) {
    fail('no-trade-window', `No-Trade-Fenster aktiv: ${context.noTrade.reason} — keine neuen Orders rund um High-Impact-Events.`);
  } else pass('no-trade-window', 'kein High-Impact-Event im Fenster');

  // ── 1c. SAFE-003: Volatilität (10_ §5a) — VIX > 40 ⇒ keine neuen Positionen ──
  if (typeof context.vix === 'number') {
    if (context.vix > SAFE_003_VIX_MAX) {
      fail('safe-003-vix', `SAFE-003: VIX ${context.vix.toFixed(1)} > ${SAFE_003_VIX_MAX} — keine neuen Positionen bei Extremvolatilität.`);
    } else pass('safe-003-vix', `VIX ${context.vix.toFixed(1)} ≤ ${SAFE_003_VIX_MAX}`);
  } else skip('safe-003-vix', 'VIX-Daten nicht verfügbar — Check ohne Datengrundlage nicht erzwingbar (ehrlich markiert)');

  // ── 1d. SAFE-003: BTC-Intraday > 10 % · ETH > 15 % ⇒ keine neuen Positionen ──
  // Marktweiter Stress-Indikator → gilt für jede neue Position (wie der VIX-Check).
  // Blueprint nennt zusätzlich „Size −50 %, SL enger" — das betrifft bestehende
  // Positionen; für NEUE Orders gilt die strengere Wirkung „keine neuen Positionen".
  const majors = context.majorsIntradayMovePct;
  const majorCheck = (name: string, label: string, move: number | null | undefined, max: number) => {
    if (typeof move !== 'number') return skip(name, `${label}-Intraday-Kerzen nicht verfügbar`);
    if (move > max) fail(name, `SAFE-003: ${label}-Intraday-Bewegung ${move.toFixed(1)} % > ${max} % — keine neuen Positionen.`);
    else pass(name, `${label}-Intraday ${move.toFixed(1)} % ≤ ${max} %`);
  };
  majorCheck('safe-003-btc', 'BTC', majors?.btc, SAFE_003_BTC_INTRADAY_MAX_PCT);
  majorCheck('safe-003-eth', 'ETH', majors?.eth, SAFE_003_ETH_INTRADAY_MAX_PCT);

  // ── 1e. SAFE-004: Latenz > 5 s ⇒ Execution pausieren (Circuit Breaker) ──
  if (typeof context.priceLatencyMs !== 'number') skip('safe-004-latency', 'keine Latenzmessung');
  else if (context.priceLatencyMs > SAFE_004_MAX_LATENCY_MS) {
    fail('safe-004-latency', `SAFE-004: Pipeline-Latenz ${(context.priceLatencyMs / 1000).toFixed(1)} s > ${SAFE_004_MAX_LATENCY_MS / 1000} s — Execution pausiert (Circuit Breaker).`);
  } else pass('safe-004-latency', `${Math.round(context.priceLatencyMs)} ms ≤ ${SAFE_004_MAX_LATENCY_MS} ms`);

  // ── 1f. SAFE-005: Datenintegrität (stale > 5 min · Z-Score > 5) ──
  // Blueprint: „LOW CONFIDENCE + manuelle Bestätigung". Das Gate läuft NACH der
  // Bestätigung und kann keine neue einholen ⇒ konservativ: Block mit Hinweis.
  if (!context.marketData) skip('safe-005-stale', 'keine Kerzen für Symbol/Timeframe');
  else {
    const age = state.now.getTime() - context.marketData.lastCandleTs.getTime();
    const limit = context.marketData.expectedMaxAgeMs + SAFE_005_STALE_TOLERANCE_MS;
    if (age > limit) {
      fail('safe-005-stale', `SAFE-005: Marktdaten veraltet (letzte Kerze ${Math.round(age / 60_000)} min alt, erlaubt ${Math.round(limit / 60_000)} min) — LOW CONFIDENCE, manuelle Prüfung nötig.`);
    } else pass('safe-005-stale', `letzte Kerze ${Math.round(age / 60_000)} min alt (≤ ${Math.round(limit / 60_000)} min)`);
  }
  if (typeof context.priceZScore !== 'number') skip('safe-005-zscore', 'zu wenig Historie oder kein Live-Preis');
  else if (Math.abs(context.priceZScore) > SAFE_005_MAX_ZSCORE) {
    fail('safe-005-zscore', `SAFE-005: Preis-Z-Score ${context.priceZScore.toFixed(1)} (|z| > ${SAFE_005_MAX_ZSCORE}) — Ausreißer/Datenfehler, LOW CONFIDENCE, manuelle Prüfung nötig.`);
  } else pass('safe-005-zscore', `|z| ${Math.abs(context.priceZScore).toFixed(1)} ≤ ${SAFE_005_MAX_ZSCORE}`);

  // ── 1g. SAFE-006: Slippage > 1 % einzeln · > 0,3 % Ø ⇒ nur Limit-Orders ──
  const slips = context.recentSlippagePct;
  if (!slips || slips.length === 0) skip('safe-006-slippage', 'keine Entry-Fills mit Slippage-Messung im 24-h-Fenster');
  else {
    const worst = Math.max(...slips);
    const avg = slips.reduce((a, b) => a + b, 0) / slips.length;
    const breached = worst > SAFE_006_MAX_SINGLE_SLIPPAGE_PCT || avg > SAFE_006_MAX_AVG_SLIPPAGE_PCT;
    const stats = `max ${worst.toFixed(2)} %, Ø ${avg.toFixed(2)} % über ${slips.length} Fill(s)`;
    if (breached && (order.orderType ?? 'market') === 'market') {
      fail('safe-006-slippage', `SAFE-006: Slippage ${stats} (Grenzen ${SAFE_006_MAX_SINGLE_SLIPPAGE_PCT} % / Ø ${SAFE_006_MAX_AVG_SLIPPAGE_PCT} %) — nur Limit-Orders zulässig, Market-Entry geblockt.`);
    } else pass('safe-006-slippage', breached ? `${stats} — Limit-Order zulässig` : stats);
  }

  // ── 1h. SAFE-008: Price-Collar 2 % (Entry vs. Live-Mark) · max 10 Orders/min ──
  if (context.markPrice === undefined) skip('safe-008-collar', 'Live-Preis nicht erhoben');
  else if (context.markPrice === null || !(context.markPrice > 0)) {
    // Sicherheitskritisch: ohne echten Live-Preis keine Order (kein Raten).
    fail('safe-008-collar', `SAFE-008: Live-Preis für ${order.symbol} nicht abrufbar — Price-Collar nicht prüfbar, Order geblockt.`);
  } else {
    const dev = (Math.abs(order.entry - context.markPrice) / context.markPrice) * 100;
    if (dev > SAFE_008_PRICE_COLLAR_PCT) {
      fail('safe-008-collar', `SAFE-008: Price-Collar verletzt — Entry ${order.entry} weicht ${dev.toFixed(2)} % vom Live-Mark ${context.markPrice} ab (> ${SAFE_008_PRICE_COLLAR_PCT} %).`);
    } else pass('safe-008-collar', `Abweichung ${dev.toFixed(2)} % ≤ ${SAFE_008_PRICE_COLLAR_PCT} %`);
  }
  if (typeof context.entryOrdersLastMinute !== 'number') skip('safe-008-rate', 'Order-Rate nicht erhoben');
  else if (context.entryOrdersLastMinute >= SAFE_008_MAX_ORDERS_PER_MIN) {
    fail('safe-008-rate', `SAFE-008: ${context.entryOrdersLastMinute} Orders in der letzten Minute — max ${SAFE_008_MAX_ORDERS_PER_MIN} Orders/min.`);
  } else pass('safe-008-rate', `${context.entryOrdersLastMinute}/${SAFE_008_MAX_ORDERS_PER_MIN} Orders/min`);

  // ── 1i. SAFE-010: Opposite-Trade-Cooldown 5 min · max 3 offene Orders je Asset ──
  if (context.lastOppositeCloseAt === undefined) skip('safe-010-cooldown', 'Trade-Historie nicht erhoben');
  else if (context.lastOppositeCloseAt === null) pass('safe-010-cooldown', 'kein Gegenrichtungs-Trade auf dem Symbol');
  else {
    const since = state.now.getTime() - context.lastOppositeCloseAt.getTime();
    if (since < SAFE_010_OPPOSITE_COOLDOWN_MS) {
      const until = new Date(context.lastOppositeCloseAt.getTime() + SAFE_010_OPPOSITE_COOLDOWN_MS);
      fail('safe-010-cooldown', `SAFE-010: Opposite-Trade-Cooldown — ${order.symbol} wurde vor ${Math.round(since / 1000)} s in Gegenrichtung geschlossen; frei ab ${until.toISOString()}.`);
    } else pass('safe-010-cooldown', `letzter Gegenrichtungs-Trade vor ${Math.round(since / 60_000)} min`);
  }
  if (typeof context.openEntryOrdersOnSymbol !== 'number') skip('safe-010-open-orders', 'offene Orders nicht erhoben');
  else if (context.openEntryOrdersOnSymbol >= SAFE_010_MAX_OPEN_ORDERS_PER_ASSET) {
    fail('safe-010-open-orders', `SAFE-010: ${context.openEntryOrdersOnSymbol} offene Orders auf ${order.symbol} — max ${SAFE_010_MAX_OPEN_ORDERS_PER_ASSET} offene Orders je Asset.`);
  } else pass('safe-010-open-orders', `${context.openEntryOrdersOnSymbol}/${SAFE_010_MAX_OPEN_ORDERS_PER_ASSET} offene Orders`);

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
    const riskDistance = Math.abs(order.entry - order.stopLoss);
    let rawQty: number;
    let riskAmount: number;
    if (order.requestedNotional !== undefined && order.requestedNotional > 0) {
      // User-Wunschbetrag: qty aus dem Betrag; riskAmount = ECHTES Risiko
      // dieser Größe bis zum Stop (ehrlich, nicht das Default-Risiko%).
      rawQty = order.requestedNotional / order.entry;
      riskAmount = roundDownToStep(rawQty, market.lotSize) * riskDistance;
    } else {
      riskAmount = state.equity * (settings.riskPctPerTrade / 100);
      rawQty = riskAmount / riskDistance;
    }

    // ── 7a. SAFE-007: > 3 Regime-Wechsel / 24 h ⇒ Size −75 % (verkleinert, blockt nicht) ──
    if (typeof context.regimeChanges24h !== 'number') skip('safe-007-regime', 'keine Regime-Daten für Symbol/Timeframe (24 h)');
    else if (context.regimeChanges24h > SAFE_007_MAX_REGIME_CHANGES_24H) {
      rawQty *= SAFE_007_SIZE_FACTOR;
      riskAmount *= SAFE_007_SIZE_FACTOR;
      pass('safe-007-regime', `SAFE-007: ${context.regimeChanges24h} Regime-Wechsel in 24 h (> ${SAFE_007_MAX_REGIME_CHANGES_24H}) — Size −75 %.`);
    } else pass('safe-007-regime', `${context.regimeChanges24h} Regime-Wechsel in 24 h`);
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
