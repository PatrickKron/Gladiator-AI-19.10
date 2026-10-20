/**
 * Agent-Wallet-Prüfung (Vision-Punkt 5): nur ein freigegebener Agent-Key der
 * hinterlegten Haupt-Wallet wird akzeptiert, nie der Haupt-Wallet-Key selbst.
 * Der letzte Test fragt die echte Hyperliquid-Testnet-Info-API ab.
 */
import { describe, expect, it } from 'vitest';
import { addressFromPrivateKey, fetchUserRole, judgeAgentRole, verifyAgentWallet } from './hyperliquid-agent.js';

// Bekannter Ethereum-Testvektor (öffentlich, ohne Guthaben)
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const KEY_ADDR = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const MAIN = '0x1111111111111111111111111111111111111111';

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('addressFromPrivateKey', () => {
  it('leitet die EVM-Adresse korrekt ab (Testvektor)', () => {
    expect(addressFromPrivateKey(KEY)).toBe(KEY_ADDR);
  });

  it('lehnt kaputte Keys ab', () => {
    expect(() => addressFromPrivateKey('0x1234')).toThrow(/64 Hex/);
  });
});

describe('judgeAgentRole', () => {
  it('Agent der hinterlegten Haupt-Wallet → ok', () => {
    const r = judgeAgentRole(MAIN, KEY_ADDR, { role: 'agent', data: { user: MAIN.toUpperCase().replace('0X', '0x') } });
    expect(r).toMatchObject({ ok: true, reason: 'agent_ok' });
  });

  it('Haupt-Wallet-Key → verweigert (könnte auszahlen)', () => {
    expect(judgeAgentRole(KEY_ADDR, KEY_ADDR, { role: 'user' })).toMatchObject({ ok: false, reason: 'main_wallet_key' });
  });

  it('normale Wallet statt Agent → verweigert', () => {
    expect(judgeAgentRole(MAIN, KEY_ADDR, { role: 'user' })).toMatchObject({ ok: false, reason: 'not_agent' });
    expect(judgeAgentRole(MAIN, KEY_ADDR, { role: 'missing' })).toMatchObject({ ok: false, reason: 'not_agent' });
  });

  it('Agent einer anderen Haupt-Wallet → verweigert', () => {
    const r = judgeAgentRole(MAIN, KEY_ADDR, { role: 'agent', data: { user: '0x2222222222222222222222222222222222222222' } });
    expect(r).toMatchObject({ ok: false, reason: 'wrong_master' });
  });
});

describe('verifyAgentWallet', () => {
  it('fragt userRole für die AGENT-Adresse ab und bewertet', async () => {
    let asked: unknown = null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      asked = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ role: 'agent', data: { user: MAIN } }));
    }) as unknown as typeof fetch;
    const r = await verifyAgentWallet(MAIN, KEY, 'testnet', fetchFn);
    expect(asked).toEqual({ type: 'userRole', user: KEY_ADDR });
    expect(r).toMatchObject({ ok: true, agentAddress: KEY_ADDR });
  });

  it('Haupt-Wallet-Key wird ohne Netzabfrage verweigert', async () => {
    const fetchFn = (async () => {
      throw new Error('darf nicht aufgerufen werden');
    }) as typeof fetch;
    expect(await verifyAgentWallet(KEY_ADDR, KEY, 'testnet', fetchFn)).toMatchObject({ reason: 'main_wallet_key' });
  });

  it('Netzfehler → ehrlich „nicht erreichbar", nie ok', async () => {
    expect(await verifyAgentWallet(MAIN, KEY, 'testnet', fakeFetch({}, 503))).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('Hyperliquid-Testnet (echte Info-API)', () => {
  it('userRole liefert für eine echte Adresse eine bekannte Rolle', async () => {
    const r = await fetchUserRole(KEY_ADDR, 'testnet');
    expect(['missing', 'user', 'agent', 'vault', 'subAccount']).toContain(r.role);
  }, 20_000);
});
