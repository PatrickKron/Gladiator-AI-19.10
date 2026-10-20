import { describe, expect, it } from 'vitest';
import { accountForHash, hashForAccount } from './trade-account.js';

describe('Konto-Schalter „Traden“', () => {
  it('Tab bestimmt das Konto: demo/wallet direkt, Agenten-Tabs → Agenten-Konto', () => {
    expect(accountForHash('#/traden?tab=demo', 'agent')).toBe('demo');
    expect(accountForHash('#/traden?tab=wallet', null)).toBe('wallet');
    expect(accountForHash('#/traden?tab=alerts', 'demo')).toBe('agent');
    expect(accountForHash('#/traden?tab=historie', null)).toBe('agent');
  });

  it('ohne (bekannten) Tab: zuletzt benutztes Konto, sonst Demo', () => {
    expect(accountForHash('#/traden', 'wallet')).toBe('wallet');
    expect(accountForHash('#/traden', null)).toBe('demo');
    expect(accountForHash('#/traden?tab=quatsch', null)).toBe('demo');
  });

  it('Hash beim Umschalten', () => {
    expect(hashForAccount('demo')).toBe('#/traden?tab=demo');
    expect(hashForAccount('agent')).toBe('#/traden?tab=positionen');
    expect(hashForAccount('wallet')).toBe('#/traden?tab=wallet');
  });
});
