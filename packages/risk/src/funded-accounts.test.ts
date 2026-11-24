import { describe, expect, it } from 'vitest';
import { checkFundedOrderGate, evaluateFundedAccount, FUNDED_PROVIDER_PRESETS } from './funded-accounts.js';

describe('Fremdgeldkonten Regel-Auswertung (Welle 22)', () => {
  it('stellt kuratierte Vorlagen inkl. FTMO, Topstep, Apex und CCXT-Subaccount bereit', () => {
    expect(FUNDED_PROVIDER_PRESETS.some((p) => p.provider === 'ftmo')).toBe(true);
    expect(FUNDED_PROVIDER_PRESETS.some((p) => p.provider === 'topstep')).toBe(true);
    expect(FUNDED_PROVIDER_PRESETS.some((p) => p.provider === 'ccxt_subaccount')).toBe(true);
  });

  it('bewertet ein gesundes Fremdgeldkonto im Plus als safe mit Ziel-Fortschritt', () => {
    const res = evaluateFundedAccount({
      startBalance: 100_000,
      currentEquity: 104_500,
      highWaterMark: 104_500,
      dailyStartEquity: 104_000,
      dailyLossLimitPct: 5,
      maxTotalDrawdownPct: 10,
      profitTargetPct: 10,
      trailingDrawdown: false,
    });
    expect(res.ruleState).toBe('safe');
    expect(res.pnlUsd).toBe(4_500);
    expect(res.pnlPct).toBe(4.5);
    expect(res.targetProgressPct).toBe(45);
    expect(res.effectiveDrawdownPct).toBe(0);
    expect(res.recommendedRiskPerTradePct).toBe(1);
    expect(res.warnings).toEqual([]);
  });

  it('warnt frühzeitig (caution) und halbiert Risiko-Empfehlung bei engem Drawdown-Puffer', () => {
    const res = evaluateFundedAccount({
      startBalance: 100_000,
      currentEquity: 92_500,
      highWaterMark: 100_000,
      dailyStartEquity: 94_000,
      dailyLossLimitPct: 5,
      maxTotalDrawdownPct: 10,
      profitTargetPct: 10,
      trailingDrawdown: false,
    });
    expect(res.ruleState).toBe('caution');
    expect(res.effectiveDrawdownPct).toBe(7.5);
    expect(res.recommendedRiskPerTradePct).toBe(0.5);
    expect(res.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('erkennt Trailing-Drawdown-Verletzung (breached) bezogen auf High-Water-Mark', () => {
    const res = evaluateFundedAccount({
      startBalance: 50_000,
      currentEquity: 50_200,
      highWaterMark: 53_000, // −5,28 % vom Hoch > 5 % Trailing-Limit!
      dailyStartEquity: 51_000,
      dailyLossLimitPct: 3,
      maxTotalDrawdownPct: 5,
      profitTargetPct: 6,
      trailingDrawdown: true,
    });
    expect(res.ruleState).toBe('breached');
    expect(res.recommendedRiskPerTradePct).toBe(0);
    expect(res.warnings[0]).toContain('Trailing-');

    const blocked = checkFundedOrderGate({
      evaluation: res,
      accountName: 'Apex 50k',
      proposedRiskUsd: 250,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('Prop-Gate blockt');
  });

  it('drosselt Order-Risiko automatisch auf 80 % des verbleibenden Prop-Puffers', () => {
    const evalTight = evaluateFundedAccount({
      startBalance: 100_000,
      currentEquity: 96_000,
      highWaterMark: 100_000,
      dailyStartEquity: 100_000, // 4 % Tagesverlust von max 5 % -> 1000 $ Restpuffer -> 800 $ Cap!
      dailyLossLimitPct: 5,
      maxTotalDrawdownPct: 10,
      profitTargetPct: 10,
      trailingDrawdown: false,
    });
    const capped = checkFundedOrderGate({
      evaluation: evalTight,
      accountName: 'FTMO 100k',
      proposedRiskUsd: 1_000,
    });
    expect(capped.allowed).toBe(true);
    expect(capped.scaled).toBe(true);
    expect(capped.maxAllowedRiskUsd).toBe(800);
    expect(capped.scaleFactor).toBe(0.8);
  });
});
