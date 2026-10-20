/**
 * Trading-Limits (Einstellungen › Trading): EINE Quelle für die Grenzen, die der
 * Server annimmt, und für die fertigen Risiko-Profile der Oberfläche. Profile
 * füllen nur das Formular vor — gespeichert wird erst auf Klick, danach ist
 * jeder Wert frei anpassbar (Profi-Trader und Meme-Coin-Zocker brauchen
 * verschiedene Grenzen). Die Risk-Engine erzwingt die gespeicherten Werte.
 */

export type TradingLimits = {
  riskPctPerTrade: number;
  maxLeverage: number;
  maxOpenPositions: number;
  /** Positionswert je Asset in % des Kontos — über 100 % nur mit Hebel. */
  maxExposurePctPerAsset: number;
  dailyLossLimitPct: number;
  weeklyLossLimitPct: number;
  maxDrawdownPct: number;
};

/** Hebel bis 125× (größter Hebel gängiger Perp-Börsen); Exposure entsprechend bis 12.500 %. */
export const SETTINGS_BOUNDS: Record<keyof TradingLimits, { min: number; max: number }> = {
  riskPctPerTrade: { min: 0.1, max: 5 },
  maxLeverage: { min: 1, max: 125 },
  maxOpenPositions: { min: 1, max: 20 },
  maxExposurePctPerAsset: { min: 1, max: 12_500 },
  dailyLossLimitPct: { min: 0.5, max: 20 },
  weeklyLossLimitPct: { min: 1, max: 40 },
  maxDrawdownPct: { min: 1, max: 60 },
};

export type RiskProfileId = 'vorsichtig' | 'standard' | 'profi' | 'aggressiv' | 'hochrisiko';

export const RISK_PROFILES: { id: RiskProfileId; limits: TradingLimits }[] = [
  {
    id: 'vorsichtig',
    limits: { riskPctPerTrade: 0.5, maxLeverage: 3, maxOpenPositions: 3, maxExposurePctPerAsset: 20, dailyLossLimitPct: 2, weeklyLossLimitPct: 5, maxDrawdownPct: 10 },
  },
  {
    id: 'standard',
    limits: { riskPctPerTrade: 1, maxLeverage: 10, maxOpenPositions: 5, maxExposurePctPerAsset: 20, dailyLossLimitPct: 3, weeklyLossLimitPct: 7, maxDrawdownPct: 15 },
  },
  {
    id: 'profi',
    limits: { riskPctPerTrade: 1.5, maxLeverage: 25, maxOpenPositions: 8, maxExposurePctPerAsset: 300, dailyLossLimitPct: 5, weeklyLossLimitPct: 10, maxDrawdownPct: 20 },
  },
  {
    id: 'aggressiv',
    limits: { riskPctPerTrade: 3, maxLeverage: 50, maxOpenPositions: 10, maxExposurePctPerAsset: 1_000, dailyLossLimitPct: 10, weeklyLossLimitPct: 20, maxDrawdownPct: 35 },
  },
  {
    id: 'hochrisiko',
    limits: { riskPctPerTrade: 5, maxLeverage: 100, maxOpenPositions: 15, maxExposurePctPerAsset: 3_000, dailyLossLimitPct: 20, weeklyLossLimitPct: 40, maxDrawdownPct: 60 },
  },
];

/** Welches Profil entspricht genau diesen Werten? null = eigene Werte. */
export function matchRiskProfile(limits: TradingLimits): RiskProfileId | null {
  const keys = Object.keys(SETTINGS_BOUNDS) as (keyof TradingLimits)[];
  return RISK_PROFILES.find((p) => keys.every((k) => Math.abs(p.limits[k] - limits[k]) < 1e-9))?.id ?? null;
}
