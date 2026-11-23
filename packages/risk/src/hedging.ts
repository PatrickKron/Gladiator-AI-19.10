import { z } from 'zod';

/**
 * Konfigurierbares Portfolio-Hedging (Welle 17):
 * Pure, deterministische Auswertungslogik für Absicherungs-Regeln
 * (Drawdown-Schwelle, VIX-Schwelle, Risk-Off-Regime, maximale Hedge-Quote
 * und bevorzugtes Absicherungs-Instrument). Kein Fake — jede Empfehlung
 * basiert auf echten Eingabewerten (VIX, GRS, Drawdown, Net-Exposure).
 */

export const HEDGING_INSTRUMENTS = [
  'inverse_perp',
  'spot_short',
  'stablecoin_shift',
  'index_hedge',
] as const;

export type HedgingInstrument = (typeof HEDGING_INSTRUMENTS)[number];

/**
 * Einzelne designte Hedging-Strategie (Welle 19):
 * Kann pro Asset zugewiesen werden (z. B. Krypto-Crash-Schutz für BTC,
 * Beta-Hedge über BTC für Altcoins, Index-Hedge für Aktien/ETFs).
 */
export const hedgingStrategySchema = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'Strategie-ID: nur Kleinbuchstaben, Ziffern, Bindestrich/Unterstrich'),
  name: z.string().min(2).max(80),
  description: z.string().max(300).default(''),
  enabled: z.boolean().default(true),
  triggerDrawdownPct: z.number().min(0.5).max(50).default(5),
  triggerVix: z.number().min(12).max(80).default(25),
  triggerOnRiskOff: z.boolean().default(true),
  maxHedgeRatioPct: z.number().min(5).max(100).default(50),
  instrument: z.enum(HEDGING_INSTRUMENTS).default('inverse_perp'),
  /** 'SAME' = direktes 1:1 Gegen-Asset; sonst Cross-Hedge (z. B. BTC/USDT, SPY, QQQ). */
  hedgeSymbol: z.string().min(1).max(32).default('SAME'),
  autoReduceExposure: z.boolean().default(true),
  /** Optionaler Stop-Loss (%) fürs Hedge-Bein zur Verlustbegrenzung bei Fehlausbruch. */
  hedgeStopLossPct: z.number().min(1).max(50).default(8),
  builtin: z.boolean().default(false),
});

export type HedgingStrategy = z.infer<typeof hedgingStrategySchema>;

export const DEFAULT_HEDGING_STRATEGIES: HedgingStrategy[] = [
  {
    id: 'crypto-crash-shield',
    name: 'Krypto-Crash-Schutz (1:1 Inverse)',
    description: 'Sichert volatile Krypto-Positionen direkt über einen 1:1 Gegen-Short auf dasselbe Asset ab.',
    enabled: true,
    triggerDrawdownPct: 5,
    triggerVix: 25,
    triggerOnRiskOff: true,
    maxHedgeRatioPct: 60,
    instrument: 'inverse_perp',
    hedgeSymbol: 'SAME',
    autoReduceExposure: true,
    hedgeStopLossPct: 7,
    builtin: true,
  },
  {
    id: 'altcoin-btc-beta',
    name: 'Altcoin Beta-Hedge über BTC',
    description: 'Sichert Altcoins (ETH, SOL, UNI, QNT …) über einen liquiden BTC/USDT-Short ab.',
    enabled: true,
    triggerDrawdownPct: 4,
    triggerVix: 24,
    triggerOnRiskOff: true,
    maxHedgeRatioPct: 45,
    instrument: 'inverse_perp',
    hedgeSymbol: 'BTC/USDT',
    autoReduceExposure: true,
    hedgeStopLossPct: 8,
    builtin: true,
  },
  {
    id: 'equity-index-shield',
    name: 'Aktien- & ETF-Index-Hedge (SPY)',
    description: 'Sichert Einzelaktien und Indizes in Risk-Off-Phasen breit über SPY ab.',
    enabled: true,
    triggerDrawdownPct: 6,
    triggerVix: 22,
    triggerOnRiskOff: true,
    maxHedgeRatioPct: 40,
    instrument: 'index_hedge',
    hedgeSymbol: 'SPY',
    autoReduceExposure: true,
    hedgeStopLossPct: 6,
    builtin: true,
  },
  {
    id: 'stablecoin-buffer',
    name: 'Konservativer Stablecoin-Puffer',
    description: 'Schichtet bei Drawdown oder Stress schrittweise bis zu 35 % in Stablecoins (USDT) um.',
    enabled: true,
    triggerDrawdownPct: 3,
    triggerVix: 28,
    triggerOnRiskOff: true,
    maxHedgeRatioPct: 35,
    instrument: 'stablecoin_shift',
    hedgeSymbol: 'USDT',
    autoReduceExposure: true,
    hedgeStopLossPct: 5,
    builtin: true,
  },
];

export const hedgingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Ab diesem Portfolio-Drawdown (%) wird Absicherung empfohlen/aktiviert. */
  triggerDrawdownPct: z.number().min(1).max(50).default(6),
  /** Ab diesem VIX-Stand wird Absicherung ausgelöst. */
  triggerVix: z.number().min(12).max(80).default(25),
  /** Automatisch auslösen, wenn der globale Risiko-Score (GRS) auf „risk-off“ steht. */
  triggerOnRiskOff: z.boolean().default(true),
  /** Maximal abzusichernder Anteil (%) der offenen Netto-Exposure. */
  maxHedgeRatioPct: z.number().min(5).max(100).default(50),
  /** Bevorzugtes Instrument zur Absicherung. */
  instrument: z.enum(HEDGING_INSTRUMENTS).default('inverse_perp'),
  /** Neue Risiko-Positionsgrößen bei aktivem Hedge automatisch halbieren. */
  autoReduceExposure: z.boolean().default(true),
  /** Bevorzugtes Hedge-Symbol (z. B. BTC/USDT, SPY, QQQ). */
  hedgeSymbol: z.string().min(1).max(32).default('BTC/USDT'),
  /** Bibliothek der Vorlagen & selbst designten Hedging-Strategien (Welle 19). */
  strategies: z
    .array(hedgingStrategySchema)
    .max(30)
    .default(() => DEFAULT_HEDGING_STRATEGIES.map((s) => ({ ...s }))),
  /** Zuordnung Asset-Symbol (z. B. 'BTC/USDT', 'RHM.DE') → Strategy-ID oder 'none'. */
  assetAssignments: z.record(z.string().min(1).max(32), z.string().min(1).max(64)).default(() => ({})),
  /** Optionale Standard-Strategie für alle nicht explizit zugeordneten Assets. */
  defaultStrategyId: z.string().max(64).nullable().default(null),
});

export type HedgingConfig = z.infer<typeof hedgingConfigSchema>;

export const DEFAULT_HEDGING_CONFIG: HedgingConfig = hedgingConfigSchema.parse({});

export function parseHedgingConfig(raw: unknown): HedgingConfig {
  const res = hedgingConfigSchema.safeParse(raw ?? {});
  return res.success ? res.data : hedgingConfigSchema.parse({});
}

export type ResolvedAssetHedging = {
  symbol: string;
  mode: 'assigned' | 'default_strategy' | 'global_fallback' | 'none';
  strategyId: string | null;
  strategyName: string;
  instrument: HedgingInstrument;
  hedgeSymbol: string;
  effectiveConfig: HedgingConfig;
};

/**
 * Ermittelt für ein konkretes Asset die gültige Hedging-Strategie:
 * 1. Explizite Asset-Zuordnung (`assetAssignments[SYMBOL]`) — 'none' schaltet Hedge für dieses Asset ab.
 * 2. Globale Standard-Strategie (`defaultStrategyId`), falls gesetzt.
 * 3. Rückfall auf die globalen Basis-Parameter von `config`.
 */
export function resolveHedgingForAsset(config: HedgingConfig, symbol: string): ResolvedAssetHedging {
  const norm = symbol.trim().toUpperCase();
  const strategiesList = config.strategies ?? [];

  let assignedId: string | undefined;
  for (const [k, v] of Object.entries(config.assetAssignments ?? {})) {
    if (k.trim().toUpperCase() === norm) {
      assignedId = v;
      break;
    }
  }

  if (assignedId === 'none') {
    return {
      symbol: norm,
      mode: 'none',
      strategyId: null,
      strategyName: 'Kein Hedge (deaktiviert)',
      instrument: config.instrument,
      hedgeSymbol: norm,
      effectiveConfig: { ...config, enabled: false },
    };
  }

  const pickStrategy = (id: string | null | undefined) =>
    id ? strategiesList.find((s) => s.id === id) ?? null : null;

  const assignedStrategy = pickStrategy(assignedId);
  const defaultStrategy = !assignedStrategy ? pickStrategy(config.defaultStrategyId) : null;
  const chosen = assignedStrategy ?? defaultStrategy;

  if (chosen) {
    const resolvedHedgeSymbol = chosen.hedgeSymbol.trim().toUpperCase() === 'SAME' ? norm : chosen.hedgeSymbol.trim().toUpperCase();
    return {
      symbol: norm,
      mode: assignedStrategy ? 'assigned' : 'default_strategy',
      strategyId: chosen.id,
      strategyName: chosen.name,
      instrument: chosen.instrument,
      hedgeSymbol: resolvedHedgeSymbol,
      effectiveConfig: {
        ...config,
        enabled: config.enabled && chosen.enabled,
        triggerDrawdownPct: chosen.triggerDrawdownPct,
        triggerVix: chosen.triggerVix,
        triggerOnRiskOff: chosen.triggerOnRiskOff,
        maxHedgeRatioPct: chosen.maxHedgeRatioPct,
        instrument: chosen.instrument,
        hedgeSymbol: resolvedHedgeSymbol,
        autoReduceExposure: chosen.autoReduceExposure,
      },
    };
  }

  return {
    symbol: norm,
    mode: 'global_fallback',
    strategyId: null,
    strategyName: 'Globale Basis-Regel',
    instrument: config.instrument,
    hedgeSymbol: config.hedgeSymbol.trim().toUpperCase() === 'SAME' ? norm : config.hedgeSymbol,
    effectiveConfig: config,
  };
}

export type AssetHedgingEvaluation = ResolvedAssetHedging & {
  evaluation: HedgingEvaluation;
};

/** Bewertet die für ein konkretes Asset zugeordnete Hedging-Strategie gegen echte Marktdaten. */
export function evaluateAssetHedging(
  config: HedgingConfig,
  symbol: string,
  ctx: HedgingContext,
): AssetHedgingEvaluation {
  const resolved = resolveHedgingForAsset(config, symbol);
  return {
    ...resolved,
    evaluation: evaluateHedging(resolved.effectiveConfig, ctx),
  };
}

export type AdaptiveHedgeSizingResult = {
  notionalUsd: number | null;
  scaled: boolean;
  scaleFactor: number;
  strategyName: string;
  hedgeSymbol: string;
  recommendedHedgePct: number;
  summary: string;
};

/**
 * Wendet den adaptiven Hedging-Skalierungsfaktor (`exposureScaleFactor`, z. B. 0,5)
 * konservativ auf eine vorgeschlagene Positionsgröße an, sobald der Asset-Hedge-Trigger
 * live aktiv ist und `autoReduceExposure` eingeschaltet wurde.
 * Erhöht NIEMALS das Risiko; unterschreitet `minNotionalUsd` nicht, wenn das Basis-Notional
 * darüber lag.
 */
export function applyAdaptiveHedgeSizing(
  baseNotionalUsd: number | null,
  minNotionalUsd: number,
  assetEval: AssetHedgingEvaluation,
): AdaptiveHedgeSizingResult {
  const factor = assetEval.evaluation.state === 'active' ? assetEval.evaluation.exposureScaleFactor : 1;
  if (baseNotionalUsd === null || !Number.isFinite(baseNotionalUsd) || baseNotionalUsd <= 0 || factor >= 1) {
    return {
      notionalUsd: baseNotionalUsd,
      scaled: false,
      scaleFactor: 1,
      strategyName: assetEval.strategyName,
      hedgeSymbol: assetEval.hedgeSymbol,
      recommendedHedgePct: assetEval.evaluation.recommendedHedgePct,
      summary: assetEval.evaluation.summary,
    };
  }
  const scaledRaw = baseNotionalUsd * factor;
  const clamped = baseNotionalUsd >= minNotionalUsd ? Math.max(minNotionalUsd, scaledRaw) : scaledRaw;
  const finalNotional = Math.min(baseNotionalUsd, clamped);
  return {
    notionalUsd: Math.round(finalNotional * 100) / 100,
    scaled: finalNotional < baseNotionalUsd - 1e-6,
    scaleFactor: factor,
    strategyName: assetEval.strategyName,
    hedgeSymbol: assetEval.hedgeSymbol,
    recommendedHedgePct: assetEval.evaluation.recommendedHedgePct,
    summary: assetEval.evaluation.summary,
  };
}

export type HedgingContext = {
  /** Aktueller Drawdown als positive Prozentzahl (z. B. 7.5 für −7,5 %). */
  drawdownPct: number | null;
  vix: number | null;
  grsLabel: 'risk-on' | 'neutral' | 'risk-off' | string | null;
  /** Summe offener Netto-Exposure in USD (0 wenn keine offenen Positionen). */
  netExposureUsd: number;
};

export type HedgingEvaluation = {
  state: 'disabled' | 'standby' | 'active';
  triggeredBy: string[];
  recommendedHedgePct: number;
  recommendedHedgeUsd: number;
  exposureScaleFactor: number;
  summary: string;
};

/**
 * Bewertet anhand der Nutzer-Konfiguration und realer Marktdaten, ob ein
 * Hedge-Trigger aktiv ist und welche Absicherungsquote daraus folgt.
 */
export function evaluateHedging(config: HedgingConfig, ctx: HedgingContext): HedgingEvaluation {
  if (!config.enabled) {
    return {
      state: 'disabled',
      triggeredBy: [],
      recommendedHedgePct: 0,
      recommendedHedgeUsd: 0,
      exposureScaleFactor: 1,
      summary: 'Hedging ist deaktiviert — keine automatische Absicherungsempfehlung aktiv.',
    };
  }

  const triggeredBy: string[] = [];
  let intensity = 0;

  if (ctx.drawdownPct !== null && Number.isFinite(ctx.drawdownPct) && ctx.drawdownPct >= config.triggerDrawdownPct) {
    triggeredBy.push(`Drawdown ${ctx.drawdownPct.toFixed(1)} % ≥ ${config.triggerDrawdownPct} %`);
    intensity += 0.55;
  }

  if (ctx.vix !== null && Number.isFinite(ctx.vix) && ctx.vix >= config.triggerVix) {
    triggeredBy.push(`VIX ${ctx.vix.toFixed(1)} ≥ ${config.triggerVix}`);
    intensity += 0.45;
  }

  if (config.triggerOnRiskOff && ctx.grsLabel === 'risk-off') {
    triggeredBy.push('Makro-Regime Risk-Off');
    intensity += 0.45;
  }

  if (triggeredBy.length === 0) {
    return {
      state: 'standby',
      triggeredBy: [],
      recommendedHedgePct: 0,
      recommendedHedgeUsd: 0,
      exposureScaleFactor: 1,
      summary: `Hedging scharf (Standby) — greift ab ${config.triggerDrawdownPct} % Drawdown, VIX ≥ ${config.triggerVix}${config.triggerOnRiskOff ? ' oder Risk-Off' : ''}.`,
    };
  }

  const clampedIntensity = Math.min(1, Math.max(0.4, intensity));
  const recommendedHedgePct = Math.round(config.maxHedgeRatioPct * clampedIntensity);
  const exposure = Math.max(0, Number.isFinite(ctx.netExposureUsd) ? ctx.netExposureUsd : 0);
  const recommendedHedgeUsd = Math.round((exposure * recommendedHedgePct) / 100);
  const exposureScaleFactor = config.autoReduceExposure ? 0.5 : 1;

  return {
    state: 'active',
    triggeredBy,
    recommendedHedgePct,
    recommendedHedgeUsd,
    exposureScaleFactor,
    summary: `Hedge-Trigger aktiv (${triggeredBy.join(' · ')}): ${recommendedHedgePct} % Absicherung empfohlen${recommendedHedgeUsd > 0 ? ` (~${recommendedHedgeUsd.toLocaleString('en-US')} $ über ${config.hedgeSymbol})` : ''}.`,
  };
}
