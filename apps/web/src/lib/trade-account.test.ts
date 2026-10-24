import { describe, expect, it } from 'vitest';
import { accountForHash, hashForAccount, TRADE_ACCOUNT_KEY, TRADE_ACCOUNTS } from './trade-account.js';
import { VIEW_PREFERENCE_KEYS } from './hotkeys.js';

describe('Konto-Schalter „Traden“', () => {
  it('Tab bestimmt das Konto: demo/wallet direkt, Agenten-Tabs → Agenten-Konto', () => {
    expect(accountForHash('#/traden?tab=demo', 'agent')).toBe('demo');
    expect(accountForHash('#/traden?tab=wallet', null)).toBe('wallet');
    expect(accountForHash('#/traden?tab=alerts', 'demo')).toBe('agent');
    expect(accountForHash('#/traden?tab=historie', null)).toBe('agent');
  });

  it('ohne (bekannten) Tab: zuletzt benutztes Konto, sonst das Agenten-Konto (wie v2 — Demo nur bewusst)', () => {
    expect(accountForHash('#/traden', 'wallet')).toBe('wallet');
    expect(accountForHash('#/traden', 'demo')).toBe('demo');
    expect(accountForHash('#/traden', null)).toBe('agent');
    expect(accountForHash('#/traden?tab=quatsch', null)).toBe('agent');
  });

  it('Agenten-Konto steht im Schalter vorn (v2: „Agenten-Konto (Paper) · Demo-Modus“)', () => {
    expect(TRADE_ACCOUNTS[0]).toBe('agent');
    expect([...TRADE_ACCOUNTS].sort()).toEqual(['agent', 'demo', 'wallet']);
  });

  it('der Merker nutzt einen neuen Schlüssel — der von v3 ungefragt gemerkte Demo-Standard gilt nicht weiter', () => {
    expect(TRADE_ACCOUNT_KEY).not.toBe('gladiator.tradeAccount');
    expect(VIEW_PREFERENCE_KEYS).toContain(TRADE_ACCOUNT_KEY);
  });

  it('Hash beim Umschalten', () => {
    expect(hashForAccount('demo')).toBe('#/traden?tab=demo');
    expect(hashForAccount('agent')).toBe('#/traden?tab=positionen');
    expect(hashForAccount('wallet')).toBe('#/traden?tab=wallet');
  });
});
