import { z } from 'zod';

/**
 * Fremdgeldkonten / Prop-Firm- & Drittkapital-Konten (Welle 22):
 * Deterministische, ehrliche Regel-Überwachung für Fremdkapital-Konten
 * (FTMO, Topstep, Apex, FundedNext, The5ers, CCXT-Subaccounts oder eigene Anbieter).
 * Strikt getrennt von Eigengeld — keine Auszahlungen/Transfers.
 */

export const FUNDED_PROVIDERS = [
  'ftmo',
  'topstep',
  'apex',
  'fundednext',
  'the5ers',
  'ccxt_subaccount',
  'custom',
] as const;
export type FundedProvider = (typeof FUNDED_PROVIDERS)[number];

export const FUNDED_PHASES = ['challenge_1', 'challenge_2', 'funded', 'subaccount'] as const;
export type FundedPhase = (typeof FUNDED_PHASES)[number];

export const FUNDED_STATUSES = ['active', 'passed', 'breached', 'archived'] as const;
export type FundedStatus = (typeof FUNDED_STATUSES)[number];

export type FundedProviderPreset = {
  provider: FundedProvider;
  label: string;
  description: string;
  defaultStartBalance: number;
  currency: 'USD' | 'EUR';
  dailyLossLimitPct: number;
  maxTotalDrawdownPct: number;
  profitTargetPct: number | null;
  payoutSplitPct: number;
  trailingDrawdown: boolean;
  defaultPhase: FundedPhase;
};

export const FUNDED_PROVIDER_PRESETS: FundedProviderPreset[] = [
  {
    provider: 'ftmo',
    label: 'FTMO (Challenge / Funded)',
    description: 'Klassische 2-Phasen-Prop-Regeln: 5 % Tagesverlust, 10 % Gesamt-Drawdown, 10 % Ziel.',
    defaultStartBalance: 100_000,
    currency: 'USD',
    dailyLossLimitPct: 5,
    maxTotalDrawdownPct: 10,
    profitTargetPct: 10,
    payoutSplitPct: 80,
    trailingDrawdown: false,
    defaultPhase: 'challenge_1',
  },
  {
    provider: 'topstep',
    label: 'Topstep (Futures Combine)',
    description: 'Futures-Fremdkapital mit 2 % Tageslimit und 4 % Trailing-Drawdown.',
    defaultStartBalance: 50_000,
    currency: 'USD',
    dailyLossLimitPct: 2,
    maxTotalDrawdownPct: 4,
    profitTargetPct: 6,
    payoutSplitPct: 90,
    trailingDrawdown: true,
    defaultPhase: 'challenge_1',
  },
  {
    provider: 'apex',
    label: 'Apex Trader Funding',
    description: 'Futures-Konto mit 5 % Trailing-Drawdown und 6 % Profit-Ziel.',
    defaultStartBalance: 50_000,
    currency: 'USD',
    dailyLossLimitPct: 3,
    maxTotalDrawdownPct: 5,
    profitTargetPct: 6,
    payoutSplitPct: 90,
    trailingDrawdown: true,
    defaultPhase: 'challenge_1',
  },
  {
    provider: 'fundednext',
    label: 'FundedNext',
    description: '5 % Tagesverlust, 10 % Gesamt-Drawdown, 8 % Challenge-Ziel.',
    defaultStartBalance: 100_000,
    currency: 'USD',
    dailyLossLimitPct: 5,
    maxTotalDrawdownPct: 10,
    profitTargetPct: 8,
    payoutSplitPct: 80,
    trailingDrawdown: false,
    defaultPhase: 'challenge_1',
  },
  {
    provider: 'the5ers',
    label: 'The5ers',
    description: '5 % Tagesverlust, 10 % Gesamt-Drawdown, 8 % Ziel (High Stakes).',
    defaultStartBalance: 100_000,
    currency: 'USD',
    dailyLossLimitPct: 5,
    maxTotalDrawdownPct: 10,
    profitTargetPct: 8,
    payoutSplitPct: 80,
    trailingDrawdown: false,
    defaultPhase: 'challenge_1',
  },
  {
    provider: 'ccxt_subaccount',
    label: 'Börsen-Fremdgeld / Sub-Account (CCXT-API)',
    description: 'Verknüpft mit einer echten Börsen-API-Verbindung (z. B. Bybit/Binance/Kraken Sub-Account) für automatische Live-Saldo-Synchronisation.',
    defaultStartBalance: 25_000,
    currency: 'USD',
    dailyLossLimitPct: 3,
    maxTotalDrawdownPct: 12,
    profitTargetPct: null,
    payoutSplitPct: 70,
    trailingDrawdown: false,
    defaultPhase: 'subaccount',
  },
  {
    provider: 'custom',
    label: 'Eigener Fremdkapital-Anbieter / Broker',
    description: 'Frei konfigurierbare Regeln für jedes Fremdgeld-, Investoren- oder Prop-Konto.',
    defaultStartBalance: 50_000,
    currency: 'EUR',
    dailyLossLimitPct: 4,
    maxTotalDrawdownPct: 10,
    profitTargetPct: 10,
    payoutSplitPct: 80,
    trailingDrawdown: false,
    defaultPhase: 'funded',
  },
];

export const fundedAccountCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  provider: z.enum(FUNDED_PROVIDERS),
  phase: z.enum(FUNDED_PHASES).default('challenge_1'),
  currency: z.enum(['USD', 'EUR']).default('USD'),
  startBalance: z.number().positive().max(100_000_000),
  currentEquity: z.number().nonnegative().max(100_000_000).optional(),
  dailyLossLimitPct: z.number().min(0.5).max(50).default(5),
  maxTotalDrawdownPct: z.number().min(1).max(80).default(10),
  profitTargetPct: z.number().min(0.5).max(200).nullable().optional(),
  payoutSplitPct: z.number().min(0).max(100).default(80),
  trailingDrawdown: z.boolean().default(false),
  exchangeConnectionId: z.string().uuid().nullable().optional(),
  notes: z.string().max(500).optional(),
});

export type FundedAccountEvalInput = {
  startBalance: number;
  currentEquity: number;
  highWaterMark: number;
  dailyStartEquity: number;
  dailyLossLimitPct: number;
  maxTotalDrawdownPct: number;
  profitTargetPct: number | null;
  trailingDrawdown: boolean;
};

export type FundedAccountEvaluation = {
  pnlUsd: number;
  pnlPct: number;
  dailyPnlUsd: number;
  dailyPnlPct: number;
  effectiveDrawdownPct: number;
  remainingDailyBufferUsd: number;
  remainingTotalBufferUsd: number;
  targetProgressPct: number | null;
  ruleState: 'safe' | 'caution' | 'breached';
  recommendedRiskPerTradePct: number;
  warnings: string[];
};

/**
 * Bewertet ein Fremdgeldkonto streng deterministisch gegen seine Anbieter-Regeln
 * (Tagesverlust-Limit, Gesamt-/Trailing-Drawdown, Profit-Ziel) und empfiehlt ein
 * passendes Risiko je Trade.
 */
export function evaluateFundedAccount(input: FundedAccountEvalInput): FundedAccountEvaluation {
  const start = Math.max(1, input.startBalance);
  const equity = Math.max(0, input.currentEquity);
  const peak = Math.max(start, input.highWaterMark, equity);
  const dayStart = Math.max(1, input.dailyStartEquity);

  const pnlUsd = Math.round((equity - start) * 100) / 100;
  const pnlPct = Math.round(((equity - start) / start) * 10_000) / 100;

  const dailyPnlUsd = Math.round((equity - dayStart) * 100) / 100;
  const dailyPnlPct = Math.round(((equity - dayStart) / dayStart) * 10_000) / 100;
  const dailyLossPct = Math.max(0, -dailyPnlPct);

  const refForDd = input.trailingDrawdown ? peak : start;
  const effectiveDrawdownPct = Math.round(Math.max(0, ((refForDd - equity) / refForDd) * 100) * 100) / 100;

  const maxDailyLossUsd = (dayStart * input.dailyLossLimitPct) / 100;
  const remainingDailyBufferUsd = Math.round(Math.max(0, maxDailyLossUsd + Math.min(0, dailyPnlUsd)) * 100) / 100;

  const minAllowedEquity = refForDd * (1 - input.maxTotalDrawdownPct / 100);
  const remainingTotalBufferUsd = Math.round(Math.max(0, equity - minAllowedEquity) * 100) / 100;

  const targetProgressPct =
    input.profitTargetPct && input.profitTargetPct > 0
      ? Math.round(Math.max(0, Math.min(200, (pnlPct / input.profitTargetPct) * 100)) * 10) / 10
      : null;

  const warnings: string[] = [];
  let ruleState: 'safe' | 'caution' | 'breached' = 'safe';

  if (effectiveDrawdownPct >= input.maxTotalDrawdownPct) {
    ruleState = 'breached';
    warnings.push(
      `${input.trailingDrawdown ? 'Trailing-' : ''}Gesamt-Drawdown verletzt (${effectiveDrawdownPct.toFixed(2)} % ≥ ${input.maxTotalDrawdownPct} %).`,
    );
  } else if (dailyLossPct >= input.dailyLossLimitPct) {
    ruleState = 'breached';
    warnings.push(`Tagesverlust-Limit erreicht (${dailyLossPct.toFixed(2)} % ≥ ${input.dailyLossLimitPct} %) — heute keine weiteren Trades!`);
  } else {
    if (effectiveDrawdownPct >= input.maxTotalDrawdownPct * 0.7) {
      ruleState = 'caution';
      warnings.push(
        `Drawdown bei ${effectiveDrawdownPct.toFixed(1)} % von max. ${input.maxTotalDrawdownPct} % — Risiko deutlich reduzieren.`,
      );
    }
    if (dailyLossPct >= input.dailyLossLimitPct * 0.65) {
      ruleState = 'caution';
      warnings.push(
        `Tagesverlust bei ${dailyLossPct.toFixed(1)} % von max. ${input.dailyLossLimitPct} % — nur noch kleine Rest-Puffer.`,
      );
    }
  }

  // Konservative Risiko-Empfehlung je Trade für Fremdgeld-Konten
  const baseSafeRisk = Math.min(1, Math.round((input.dailyLossLimitPct / 5) * 100) / 100);
  const recommendedRiskPerTradePct =
    ruleState === 'breached'
      ? 0
      : ruleState === 'caution'
        ? Math.max(0.25, Math.round((baseSafeRisk * 0.5) * 100) / 100)
        : Math.max(0.25, baseSafeRisk);

  return {
    pnlUsd,
    pnlPct,
    dailyPnlUsd,
    dailyPnlPct,
    effectiveDrawdownPct,
    remainingDailyBufferUsd,
    remainingTotalBufferUsd,
    targetProgressPct,
    ruleState,
    recommendedRiskPerTradePct,
    warnings,
  };
}
