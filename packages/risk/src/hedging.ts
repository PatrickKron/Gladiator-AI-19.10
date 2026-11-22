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
});

export type HedgingConfig = z.infer<typeof hedgingConfigSchema>;

export const DEFAULT_HEDGING_CONFIG: HedgingConfig = hedgingConfigSchema.parse({});

export function parseHedgingConfig(raw: unknown): HedgingConfig {
  const res = hedgingConfigSchema.safeParse(raw ?? {});
  return res.success ? res.data : { ...DEFAULT_HEDGING_CONFIG };
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
