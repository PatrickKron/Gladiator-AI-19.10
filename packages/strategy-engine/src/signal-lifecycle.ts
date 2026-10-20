import { ema } from './indicators.js';
import { computeScore } from './scoring.js';
import { detectStructure } from './structure.js';
import type { Candle } from './types.js';

/**
 * Reentry- & Leverage-Upgrade-Engine + Auto-Kill (05_ §9, Werte aus der
 * Multi-Setup-Tabelle 05_ §5). REINE Funktionen — der Monitor-Job
 * (@gladiator/jobs signal-lifecycle) füttert sie mit ECHTEN Kerzen/Preisen.
 *
 * EIN Datenmodell (Alt-Bug flach vs. verschachtelt): Die Pläne liegen flach
 * in signals.reentry / signals.leverage_upgrade und werden genau so gelesen,
 * wie sie hier geschrieben werden.
 *
 * Mensch im Loop: Nichts hier führt etwas aus. Reentry erzeugt höchstens ein
 * NEUES Signal zur Bestätigung, Leverage-Upgrade nur einen sichtbaren
 * Vorschlag — der Hebel einer Position wird nie automatisch geändert.
 */

export type LifecycleDirection = 'long' | 'short';
export type LifecycleSetupType = 'scalp' | 'swing' | 'position';

/** 05_ §5 (Reentry-Pullback, Leverage-Upgrade) + §9 (Faktor/Max je Setup-Typ). */
export const SETUP_LIFECYCLE_RULES: Record<
  LifecycleSetupType,
  {
    reentry: { minPullbackPct: number; maxPullbackPct: number };
    leverageUpgrade: { triggerPct: number; multiplier: number; maxLeverage: number };
  }
> = {
  scalp: { reentry: { minPullbackPct: 1.5, maxPullbackPct: 2.0 }, leverageUpgrade: { triggerPct: 2, multiplier: 2, maxLeverage: 20 } },
  swing: { reentry: { minPullbackPct: 1.5, maxPullbackPct: 2.5 }, leverageUpgrade: { triggerPct: 5, multiplier: 1.5, maxLeverage: 10 } },
  position: { reentry: { minPullbackPct: 2, maxPullbackPct: 3 }, leverageUpgrade: { triggerPct: 7, multiplier: 5, maxLeverage: 50 } },
};

/** 05_ §9 Auto-Kill: „Score fällt < 6,5". */
export const AUTO_KILL_SCORE_THRESHOLD = 6.5;
/** 05_ §9: Reentry = „zweite Einstiegschance" → genau EINE Wiederholung je Ursprungs-Setup. */
export const MAX_REENTRIES = 1;

/** Pivot-Parameter für den Struktur-Check (wie SMC Core, 05_ §4: Left=Right=8). */
const STRUCTURE_BARS = 8;
const EMA_TREND_PERIOD = 200;

export type ReentryPlan = {
  enabled: boolean;
  minPullbackPct: number;
  maxPullbackPct: number;
  /** Preis-Zone des Pullback-Fensters (Long unter, Short über Entry). */
  zoneLow: number;
  zoneHigh: number;
  maxReentries: number;
  /** 0 = Ursprungs-Signal, 1 = erster Reentry, … */
  generation: number;
  parentSignalId?: string;
  rootSignalId?: string;
};

export type LeverageUpgradeSuggestion = {
  suggested: number;
  from: number;
  movePct: number;
  reason: string;
  at: string;
  positionId: string;
  price: number;
};

export type LeverageUpgradePlan = {
  triggerPct: number;
  multiplier: number;
  maxLeverage: number;
  suggestion?: LeverageUpgradeSuggestion;
};

export type SetupGeometry = {
  direction: LifecycleDirection;
  setupType: LifecycleSetupType;
  entry: number;
  stopLoss: number;
};

/** Pullback-Zone in Preisen: Long −min…−max % unter Entry, Short spiegelbildlich darüber. */
export function reentryZone(direction: LifecycleDirection, entry: number, minPct: number, maxPct: number) {
  return direction === 'long'
    ? { low: entry * (1 - maxPct / 100), high: entry * (1 - minPct / 100) }
    : { low: entry * (1 + minPct / 100), high: entry * (1 + maxPct / 100) };
}

/**
 * Reentry-Plan beim Erzeugen eines Setups. Aktiv nur, wenn die Zone (zumindest
 * ihr entry-naher Rand) VOR dem Stop liegt — sonst läge die zweite Chance
 * jenseits der Invalidierung (enger Scalp-Stop) und wird ehrlich deaktiviert.
 */
export function deriveReentryPlan(
  setup: SetupGeometry,
  lineage: { generation?: number; parentSignalId?: string; rootSignalId?: string } = {},
): ReentryPlan {
  const rules = SETUP_LIFECYCLE_RULES[setup.setupType].reentry;
  const zone = reentryZone(setup.direction, setup.entry, rules.minPullbackPct, rules.maxPullbackPct);
  const generation = lineage.generation ?? 0;
  const beforeStop = setup.direction === 'long' ? zone.high > setup.stopLoss : zone.low < setup.stopLoss;
  return {
    enabled: beforeStop && generation < MAX_REENTRIES,
    minPullbackPct: rules.minPullbackPct,
    maxPullbackPct: rules.maxPullbackPct,
    zoneLow: zone.low,
    zoneHigh: zone.high,
    maxReentries: MAX_REENTRIES,
    generation,
    ...(lineage.parentSignalId ? { parentSignalId: lineage.parentSignalId } : {}),
    ...(lineage.rootSignalId ? { rootSignalId: lineage.rootSignalId } : {}),
  };
}

export function deriveLeverageUpgradePlan(setupType: LifecycleSetupType): LeverageUpgradePlan {
  return { ...SETUP_LIFECYCLE_RULES[setupType].leverageUpgrade };
}

/** Beide Pläne für ein neues Setup (signal-scan / dsl-scan). */
export function deriveLifecyclePlans(setup: SetupGeometry): { reentry: ReentryPlan; leverageUpgrade: LeverageUpgradePlan } {
  return { reentry: deriveReentryPlan(setup), leverageUpgrade: deriveLeverageUpgradePlan(setup.setupType) };
}

// ─── Neu-Bewertung (05_ §6-Gewichte) ──────────────────────────────────────

export type RescoreInput = {
  direction: LifecycleDirection;
  stopLoss: number;
  takeProfits: number[];
  /** Confluence-Tags des Signals — Herkunft der Bewertung (SMC-Gewichte oder DSL-RR). */
  confluence: string[];
  /** Geschlossene Kerzen der Signal-Timeframe, aufsteigend (echte Daten). */
  candles: Candle[];
  /** Aktueller Preis; fehlt → letzter Schlusskurs. */
  price?: number;
  /** Trend der höheren Timeframe (Multi-TF); fehlt → Wert vom Erstellungszeitpunkt. */
  higherTfTrend?: 'bull' | 'bear' | 'neutral';
  /** Gegenläufiger Struktur-Bruch seit Erstellung (aus assessOpenSignal). */
  structureBroken?: boolean;
};

/**
 * Bewertet ein bestehendes Signal zum JETZIGEN Stand neu — mit genau der
 * Formel, mit der es entstand:
 *  - SMC-Signale (Tags aus computeScore): Trend (EMA200), Struktur,
 *    RR ≥ 2 (zum aktuellen Preis) und Higher-TF werden NEU gemessen; die
 *    übrigen Faktoren (Retest, RSI, Volumen, FVG, Session) beschreiben das
 *    Entstehungs-Ereignis und bleiben, wie sie waren.
 *  - DSL-Signale ('score:rr-basiert'): min(10, RR1 × 3) zum aktuellen Preis.
 *  - Sonst (Pine/manuell/…): null — kein erfundener Score.
 */
export function rescoreSignal(input: RescoreInput): { score: number; confluence: string[] } | null {
  const last = input.candles[input.candles.length - 1];
  const price = input.price ?? last?.close;
  if (price === undefined || !(price > 0)) return null;
  const sign = input.direction === 'long' ? 1 : -1;
  const risk = (price - input.stopLoss) * sign;
  const tags = new Set(input.confluence);

  if (tags.has('score:rr-basiert')) {
    const tp1 = input.takeProfits[0];
    if (tp1 === undefined) return null;
    const reward = (tp1 - price) * sign;
    const rr1 = risk > 0 ? Math.max(0, reward) / risk : 0;
    const score = Math.min(10, Math.round(rr1 * 30) / 10);
    return { score, confluence: input.confluence };
  }

  const smc = tags.has('Trend (EMA)') || tags.has('Struktur-Bruch') || tags.has('Retest@EMA/Level');
  if (!smc) return null;

  const closes = input.candles.map((c) => c.close);
  const emaNow = ema(closes, EMA_TREND_PERIOD)[closes.length - 1];
  const trendAligned = emaNow == null ? tags.has('Trend (EMA)') : (price - emaNow) * sign > 0;
  const lastTp = input.takeProfits[input.takeProfits.length - 1];
  const rr = risk > 0 && lastTp !== undefined ? ((lastTp - price) * sign) / risk : 0;
  const higherTf: 'aligned' | 'neutral' | 'opposed' =
    input.higherTfTrend === undefined
      ? tags.has('Higher-TF bestätigt')
        ? 'aligned'
        : tags.has('Higher-TF dagegen')
          ? 'opposed'
          : 'neutral'
      : input.higherTfTrend === 'neutral'
        ? 'neutral'
        : (input.higherTfTrend === 'bull') === (input.direction === 'long')
          ? 'aligned'
          : 'opposed';

  return computeScore({
    trendAligned,
    structureBreak: tags.has('Struktur-Bruch') && !input.structureBroken,
    validRetest: tags.has('Retest@EMA/Level'),
    rsiInBand: tags.has('RSI-Band'),
    volumeConfirmed: tags.has('Volumen'),
    fvgTarget: tags.has('FVG-Ziel'),
    sessionActive: tags.has('Session aktiv'),
    rrAtLeast2: rr >= 2,
    higherTf,
    counterConfluence: tags.has('Gegen-Liquidität nahe'),
  });
}

// ─── Auto-Kill (offene 'new'-Signale) ──────────────────────────────────────

export type AutoKillReason = 'stop_breached' | 'structure_broken' | 'score_below_threshold';

export type OpenSignalInput = Omit<RescoreInput, 'structureBroken'> & {
  /** Score bei Erstellung. */
  score: number;
  createdAt: Date;
};

export type OpenSignalAssessment = {
  /** Neu berechneter Score (null = Herkunft nicht neu bewertbar). */
  score: number | null;
  stopBreached: boolean;
  structureBroken: boolean;
  kill: { reason: AutoKillReason; detail: string } | null;
};

/** Gegenläufiger BOS/CHoCH NACH der Erstellung (Swings wie SMC Core, look-ahead-frei). */
export function structureBrokenSince(candles: Candle[], direction: LifecycleDirection, createdAt: Date): boolean {
  let createdIdx = -1;
  for (let i = 0; i < candles.length; i++) if (candles[i]!.ts.getTime() < createdAt.getTime()) createdIdx = i;
  const against = direction === 'long' ? 'bearish' : 'bullish';
  return detectStructure(candles, { leftBars: STRUCTURE_BARS, rightBars: STRUCTURE_BARS }).some(
    (e) => e.index > createdIdx && e.direction === against,
  );
}

/**
 * 05_ §9 Auto-Kill für ein noch nicht bestätigtes Signal. Reihenfolge der
 * Gründe: Stop vor Entry gerissen > Struktur gegen das Setup gebrochen >
 * Score unter 6,5 gefallen. Nur Kerzen NACH der Erstellung zählen für den
 * Stop-Check (ein Docht davor war beim Erzeugen schon bekannt).
 */
export function assessOpenSignal(input: OpenSignalInput): OpenSignalAssessment {
  const created = input.createdAt.getTime();
  const after = input.candles.filter((c) => c.ts.getTime() >= created);
  const long = input.direction === 'long';
  const candleBreach = after.some((c) => (long ? c.low <= input.stopLoss : c.high >= input.stopLoss));
  const priceBreach = input.price !== undefined && (long ? input.price <= input.stopLoss : input.price >= input.stopLoss);
  const stopBreached = candleBreach || priceBreach;
  const structureBroken = structureBrokenSince(input.candles, input.direction, input.createdAt);
  const re = rescoreSignal({ ...input, structureBroken });
  const score = re?.score ?? null;

  let kill: OpenSignalAssessment['kill'] = null;
  if (stopBreached) {
    kill = { reason: 'stop_breached', detail: `Preis hat den Stop ${input.stopLoss} vor dem Entry erreicht.` };
  } else if (structureBroken) {
    kill = { reason: 'structure_broken', detail: 'Gegenläufiger Struktur-Bruch (BOS/CHoCH) nach Erstellung.' };
  } else if (score !== null && score < AUTO_KILL_SCORE_THRESHOLD && score < input.score) {
    // „fällt": nur ein echter Rückgang zählt — ein schon bei Erstellung
    // niedriger, unveränderter Score ist kein Kill-Ereignis.
    kill = { reason: 'score_below_threshold', detail: `Score ${input.score} → ${score} (< ${AUTO_KILL_SCORE_THRESHOLD}).` };
  }
  return { score, stopBreached, structureBroken, kill };
}

// ─── Reentry (nach SL/TP-Schluss) ─────────────────────────────────────────

export type ReentryInput = {
  plan: ReentryPlan;
  direction: LifecycleDirection;
  stopLoss: number;
  takeProfits: number[];
  price: number;
  structureBroken: boolean;
  /** Neu-Score zum aktuellen Preis (null = nicht bewertbar). */
  rescoredScore: number | null;
};

export type ReentryDecision =
  | { trigger: true; entry: number; reason?: undefined }
  | {
      trigger: false;
      reason:
        | 'plan_disabled'
        | 'max_reentries'
        | 'outside_zone'
        | 'beyond_stop'
        | 'targets_passed'
        | 'structure_broken'
        | 'not_rescorable'
        | 'score_below_threshold';
    };

/**
 * 05_ §9: Reentry triggert im Pullback-Fenster (Long −max…−min % unter dem
 * ursprünglichen Entry) → zweite Einstiegschance zum Live-Preis, mit
 * DERSELBEN Invalidierung (Stop) und denselben Zielen. Zusätzlich muss das
 * Setup noch tragen: Struktur intakt, Neu-Score ≥ 6,5 (sonst würde der
 * Auto-Kill das neue Signal sofort wieder entwerten).
 */
export function evaluateReentry(input: ReentryInput): ReentryDecision {
  const { plan, price } = input;
  if (!plan.enabled) return { trigger: false, reason: 'plan_disabled' };
  if (plan.generation >= plan.maxReentries) return { trigger: false, reason: 'max_reentries' };
  if (price < plan.zoneLow || price > plan.zoneHigh) return { trigger: false, reason: 'outside_zone' };
  const sign = input.direction === 'long' ? 1 : -1;
  if ((price - input.stopLoss) * sign <= 0) return { trigger: false, reason: 'beyond_stop' };
  if (input.takeProfits.length === 0 || input.takeProfits.some((tp) => (tp - price) * sign <= 0)) {
    return { trigger: false, reason: 'targets_passed' };
  }
  if (input.structureBroken) return { trigger: false, reason: 'structure_broken' };
  if (input.rescoredScore === null) return { trigger: false, reason: 'not_rescorable' };
  if (input.rescoredScore < AUTO_KILL_SCORE_THRESHOLD) return { trigger: false, reason: 'score_below_threshold' };
  return { trigger: true, entry: price };
}

// ─── Leverage-Upgrade (offene Position) ────────────────────────────────────

export type LeverageUpgradeInput = {
  plan: LeverageUpgradePlan;
  direction: LifecycleDirection;
  entryPrice: number;
  price: number;
  currentLeverage: number;
  /** Hebel-Cap der Risk-Engine (trading_settings.maxLeverage) — überstimmt das Upgrade (06_ §5). */
  riskMaxLeverage: number;
  /** Aktueller Stop der Position (null = keiner gefunden). */
  stopPrice: number | null;
};

/**
 * 05_ §9: Bewegung in Trendrichtung ≥ Trigger → Hebel × Faktor, gedeckelt
 * durch Setup-Max UND Risk-Engine. Bestätigung zusätzlich Pflicht: der Stop
 * sichert bereits den Entry (Break-Even nach TP1 bzw. nachgezogener Trailing-
 * Stop) — ein Upgrade erhöht nie das Risiko einer noch ungesicherten Position.
 * Liefert NUR einen Vorschlag; angewendet wird nichts.
 */
export function evaluateLeverageUpgrade(
  input: LeverageUpgradeInput,
): { suggested: number; from: number; movePct: number } | null {
  const sign = input.direction === 'long' ? 1 : -1;
  const movePct = Math.round((((input.price - input.entryPrice) * sign) / input.entryPrice) * 100 * 100) / 100;
  if (movePct < input.plan.triggerPct) return null;
  if (input.stopPrice === null || (input.stopPrice - input.entryPrice) * sign < 0) return null;
  const cap = Math.min(input.plan.maxLeverage, input.riskMaxLeverage);
  const raw = Math.min(input.currentLeverage * input.plan.multiplier, cap);
  const suggested = Math.floor(raw * 10 + 1e-9) / 10;
  if (!(suggested > input.currentLeverage)) return null;
  return { suggested, from: input.currentLeverage, movePct };
}
