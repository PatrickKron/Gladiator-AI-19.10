/**
 * Token-Sicherheitscheck: Bewertung von Solana-Mint-Konten und GoPlus-Antworten;
 * „echte Daten“ fragt die Solana-Kette und GoPlus live ab (in der CI).
 */
import { describe, expect, it } from 'vitest';
import { fetchTokenDiscovery } from './discovery.js';
import { fetchSolanaTop10Pct, fetchTokenSafety, goPlusSolanaTop10Pct, goPlusTop10Pct, judgeGoPlus, judgeSolanaMint, solanaTop10Pct, TOP10_WARN_PCT } from './token-safety.js';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EHFLp88EzTEbtKFFuh6';
const mint = (info: Record<string, unknown>, owner = TOKEN) => ({ owner, data: { parsed: { type: 'mint', info } } });

describe('judgeSolanaMint', () => {
  it('Mint- und Freeze-Authority widerrufen → sauber', () => {
    expect(judgeSolanaMint(mint({ mintAuthority: null, freezeAuthority: null }))).toMatchObject({ checked: true, severe: [], warnings: [], taxPct: 0 });
  });

  it('aktive Authorities → Warnungen (kein Block)', () => {
    expect(judgeSolanaMint(mint({ mintAuthority: 'Abc', freezeAuthority: 'Def' })).warnings).toEqual(['mint_authority', 'freeze_authority']);
  });

  it('Token-2022: permanenter Delegierter + nicht übertragbar = schwer, Transfergebühr = Steuer', () => {
    const r = judgeSolanaMint(
      mint(
        {
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [
            { extension: 'permanentDelegate', state: { delegate: 'Evil' } },
            { extension: 'nonTransferable' },
            { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 250 }, olderTransferFee: { transferFeeBasisPoints: 100 } } },
          ],
        },
        TOKEN22,
      ),
    );
    expect(r.severe).toEqual(['permanent_delegate', 'non_transferable']);
    expect(r.taxPct).toBe(2.5);
  });

  it('kein Token-Konto → schwer (not_a_token)', () => {
    expect(judgeSolanaMint(null).severe).toEqual(['not_a_token']);
    expect(judgeSolanaMint({ owner: '11111111111111111111111111111111' }).severe).toEqual(['not_a_token']);
  });
});

describe('judgeGoPlus', () => {
  it('Honeypot/Verkaufssperre/Saldo-Manipulation = schwer; Steuer als %', () => {
    const r = judgeGoPlus({ is_honeypot: '1', cannot_sell_all: '1', owner_change_balance: '1', buy_tax: '0.02', sell_tax: '0.35', is_mintable: '1', is_open_source: '0' });
    expect(r.severe).toEqual(['honeypot', 'cannot_sell_all', 'owner_change_balance']);
    expect(r.warnings).toEqual(['mint_authority', 'not_open_source']);
    expect(r.taxPct).toBeCloseTo(35, 9);
  });

  it('sauberer Token; fehlende Steuerangaben → Steuer unbekannt (null)', () => {
    expect(judgeGoPlus({ is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_open_source: '1' })).toMatchObject({ severe: [], warnings: [], taxPct: 0 });
    expect(judgeGoPlus({ is_honeypot: '0' }).taxPct).toBeNull();
  });

  it('unbekannter Token → nicht geprüft (nie „sicher“ geraten)', () => {
    expect(judgeGoPlus(undefined)).toMatchObject({ checked: false });
  });
});

describe('Top-10-Konzentration', () => {
  it('Solana: nur Wallets (auf der Kurve) zählen, je Besitzer zusammengefasst, Anteil am Gesamtangebot', () => {
    const acc = (amount: string, owner: string | null, ownerIsWallet = true) => ({ amount, owner, ownerIsWallet });
    // Pool (Programm-Adresse) hält 50 %, zwei Konten derselben Wallet je 10 %, eine andere 5 %
    const pct = solanaTop10Pct([acc('500', 'POOL', false), acc('100', 'W1'), acc('100', 'W1'), acc('50', 'W2'), acc('10', null)], '1000');
    expect(pct).toBe(25);
    // mehr als 10 Wallets → nur die 10 größten
    const many = Array.from({ length: 12 }, (_, i) => acc('10', `W${i}`));
    expect(solanaTop10Pct(many, '1000')).toBe(10);
    expect(solanaTop10Pct([acc('1', 'W')], '0')).toBeNull();
  });

  it('GoPlus Solana: nur Wallets auf der Kurve (Pools/PDAs raus), gesperrte Bestände raus', () => {
    // echte Adressen: eine Wallet (auf der Kurve) und das Jupiter-Programm-PDA-artige Konto (nicht auf der Kurve)
    const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const PDA = 'FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B'; // ATA = PDA, liegt nie auf der Kurve
    expect(goPlusSolanaTop10Pct([{ account: PDA, percent: '0.5' }, { account: WALLET, percent: '0.12' }, { account: WALLET, percent: '0.3', is_locked: 1 }])).toBe(12);
    expect(goPlusSolanaTop10Pct(undefined)).toBeNull();
  });

  it('GoPlus: Verträge und gesperrte Bestände zählen nicht; Warnung ab der Schwelle', () => {
    const holders = [
      { percent: '0.30', is_contract: 1, is_locked: 0 },
      { percent: '0.20', is_contract: 0, is_locked: 1 },
      { percent: '0.25', is_contract: 0, is_locked: 0 },
      { percent: '0.08', is_contract: '0', is_locked: '0' },
    ];
    expect(goPlusTop10Pct(holders)).toBe(33);
    expect(goPlusTop10Pct([])).toBeNull();
    const r = judgeGoPlus({ is_honeypot: '0', buy_tax: '0', sell_tax: '0', holders });
    expect(r.top10Pct).toBe(33);
    expect(r.warnings).toContain('top10_concentrated');
    expect(33 > TOP10_WARN_PCT).toBe(true);
    expect(judgeGoPlus({ holders: [{ percent: '0.05', is_contract: 0, is_locked: 0 }] }).warnings).not.toContain('top10_concentrated');
  });
});

describe('fetchTokenSafety', () => {
  it('Netzfehler → checked false mit Grund', async () => {
    const r = await fetchTokenSafety('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', (async () => new Response('x', { status: 503 })) as typeof fetch);
    expect(r).toMatchObject({ checked: false, severe: [] });
    expect(r.error).toMatch(/503/);
  });
});

describe('echte Daten (Solana-RPC, GoPlus)', () => {
  it('USDC auf Solana: Token-Programm, Mint-/Freeze-Authority aktiv (Circle) → Warnungen, kein Block', async () => {
    const r = await fetchTokenSafety('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(r).toMatchObject({ checked: true, source: 'chain', severe: [] });
    expect(r.warnings).toContain('freeze_authority');
  }, 30_000);

  it('BONK: Mint-Authority widerrufen', async () => {
    const r = await fetchTokenSafety('solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(r.checked).toBe(true);
    expect(r.warnings).not.toContain('mint_authority');
    expect(r.severe).toEqual([]);
  }, 30_000);

  it('Halter-Konzentration echter Solana-Tokens (Im Trend, GeckoTerminal) über GoPlus Solana', async () => {
    const tokens = (await fetchTokenDiscovery('solana', 'trending')).slice(0, 5);
    expect(tokens.length).toBeGreaterThan(0);
    const results: number[] = [];
    const problems: string[] = [];
    for (const t of tokens) {
      try {
        const pct = await fetchSolanaTop10Pct(t.address, fetch, {});
        if (pct !== null) results.push(pct);
        else problems.push(`${t.symbol}: keine Halter`);
      } catch (err) {
        problems.push(`${t.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // bei Fehlschlag die echten Antworten zeigen (Diagnose)
    expect(results.length, problems.join(' | ')).toBeGreaterThan(0);
    for (const pct of results) {
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  }, 60_000);

  it('USDC auf Base über GoPlus: kein Honeypot, Steuer 0', async () => {
    const r = await fetchTokenSafety('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(r).toMatchObject({ checked: true, source: 'goplus' });
    expect(r.severe).not.toContain('honeypot');
    expect(r.taxPct).toBe(0);
    // Circle kann USDC pausieren — Warnung, kein Block
    expect(r.severe).toEqual([]);
  }, 30_000);
});
