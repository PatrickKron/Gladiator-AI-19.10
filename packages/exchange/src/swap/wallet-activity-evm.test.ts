/**
 * Swaps fremder EVM-Wallets erkennen: Kauf mit ETH bzw. WETH, Verkauf (WETH-
 * Erlös sichtbar oder über Router), Token↔Token; Überweisungen, Airdrops und
 * NFTs nie als Swap. „Echte Daten“ liest echte Logs von Base (CI).
 */
import { describe, expect, it } from 'vitest';
import { SWAP_CHAINS } from './chains.js';
import {
  deriveEvmSwap,
  ERC20_TRANSFER_TOPIC,
  EVM_LOG_RPCS,
  fetchEvmWalletSwaps,
  fetchTokenOutflows,
  liquidityMintTxs,
  logRpcCandidates,
  padTopic,
  setEvmRetryDelayForTests,
  unwrappedIn,
  UNISWAP_V4_POOL_MANAGER,
  V4_MODIFY_LIQUIDITY_TOPIC,
  V4_SWAP_TOPIC,
  v4SwapIn,
  WETH_WITHDRAWAL_TOPIC,
  type EvmLog,
} from './wallet-activity-evm.js';

const ME = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';
const MEME = '0x4444444444444444444444444444444444444444';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = SWAP_CHAINS.base.wrappedNative;
const dec = () => 18;

const transfer = (token: string, from: string, to: string, amount: bigint): EvmLog => ({
  address: token,
  topics: [ERC20_TRANSFER_TOPIC, padTopic(from), padTopic(to)],
  data: `0x${amount.toString(16).padStart(64, '0')}`,
  transactionHash: '0xabc',
  blockNumber: '0x10',
});

describe('deriveEvmSwap', () => {
  it('Kauf mit ETH (value) → Token rein', () => {
    const s = deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0xde0b6b3a7640000' }, [transfer(MEME, POOL, ME, 5000n)], ME, dec, 1_700_000_000);
    expect(s).toMatchObject({ side: 'buy', token: MEME, tokenAtomic: 5000n, nativeAtomic: 10n ** 18n, counterToken: null, time: 1_700_000_000 });
  });

  it('Kauf mit WETH zählt als nativ; Adressen in Großschreibung egal', () => {
    const s = deriveEvmSwap('base', '0xabc', { from: ME.toUpperCase().replace('0X', '0x'), to: ROUTER, value: '0x0' }, [transfer(WETH, ME, POOL, 7n), transfer(MEME.toUpperCase().replace('0X', '0x'), POOL, ME, 9n)], ME, dec, null);
    expect(s).toMatchObject({ side: 'buy', token: MEME, nativeAtomic: 7n });
  });

  it('Verkauf nur mit sichtbarem Erlös: WETH an die Wallet oder Unwrap im Receipt', () => {
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n), transfer(WETH, POOL, ME, 3n)], ME, dec, null)).toMatchObject({ side: 'sell', token: MEME, tokenAtomic: 9n, nativeAtomic: 3n });
    // Router zahlt natives ETH aus (Unwrap in derselben Tx)
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null, 4n)).toMatchObject({ side: 'sell', token: MEME, nativeAtomic: 4n });
    // Token geht an einen Vertrag ohne sichtbaren Erlös (Bridge, Staking, Multisend) → kein Verkauf
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null)).toBeNull();
  });

  it('Unwrap-Summe aus dem Receipt: Withdrawal des Wrapped-Native bzw. Burn (Arbitrum aeWETH)', () => {
    const w = (addr: string, amount: bigint) => ({ address: addr, topics: [WETH_WITHDRAWAL_TOPIC, padTopic(ROUTER)], data: `0x${amount.toString(16).padStart(64, '0')}` });
    expect(unwrappedIn('base', [w(WETH, 5n), w(WETH.toUpperCase().replace('0X', '0x'), 2n), w(MEME, 100n), transfer(MEME, ME, POOL, 9n)])).toBe(7n);
    const ARB_WETH = SWAP_CHAINS.arbitrum.wrappedNative;
    const ZERO = '0x0000000000000000000000000000000000000000';
    expect(unwrappedIn('arbitrum', [transfer(ARB_WETH, ROUTER, ZERO, 8n), transfer(MEME, ROUTER, ZERO, 50n)])).toBe(8n);
    // meldet ein Vertrag beides, nie doppelt zählen
    expect(unwrappedIn('base', [w(WETH, 5n), transfer(WETH, ROUTER, ZERO, 5n)])).toBe(5n);
  });

  it('Uniswap v4 (natives ETH ohne WETH): Token an den PoolManager + dessen Swap-Ereignis = Verkauf, Erlös ehrlich unbekannt', () => {
    const PM = UNISWAP_V4_POOL_MANAGER.base;
    const tx = { from: ME, to: ROUTER, value: '0x0' };
    expect(deriveEvmSwap('base', '0xabc', tx, [transfer(MEME, ME, PM, 9n)], ME, dec, null, 0n, true)).toMatchObject({ side: 'sell', token: MEME, tokenAtomic: 9n, nativeAtomic: null, counterToken: null });
    // ohne Swap-Ereignis (z. B. Liquidität hinzufügen) → kein Verkauf
    expect(deriveEvmSwap('base', '0xabc', tx, [transfer(MEME, ME, PM, 9n)], ME, dec, null, 0n, false)).toBeNull();
    // Token ging (auch) woanders hin → nicht raten
    expect(deriveEvmSwap('base', '0xabc', tx, [transfer(MEME, ME, PM, 9n), transfer(MEME, ME, POOL, 1n)], ME, dec, null, 0n, true)).toBeNull();
    // PoolManager einer anderen Kette zählt nicht
    expect(deriveEvmSwap('base', '0xabc', tx, [transfer(MEME, ME, UNISWAP_V4_POOL_MANAGER.ethereum, 9n)], ME, dec, null, 0n, true)).toBeNull();
    // nicht von der Wallet selbst ausgelöst → kein eigener Verkauf
    expect(deriveEvmSwap('base', '0xabc', { ...tx, from: POOL }, [transfer(MEME, ME, PM, 9n)], ME, dec, null, 0n, true)).toBeNull();
  });

  it('v4-Swap-Ereignis im Receipt: nur vom PoolManager derselben Kette', () => {
    const ev = (addr: string) => ({ address: addr, topics: [V4_SWAP_TOPIC, `0x${'ab'.repeat(32)}`, padTopic(ROUTER)] });
    expect(v4SwapIn('base', [transfer(MEME, ME, POOL, 1n), ev(UNISWAP_V4_POOL_MANAGER.base.toUpperCase().replace('0X', '0x'))])).toBe(true);
    expect(v4SwapIn('base', [ev(POOL)])).toBe(false);
    expect(v4SwapIn('base', [ev(UNISWAP_V4_POOL_MANAGER.arbitrum)])).toBe(false);
    expect(v4SwapIn('solana', [ev(UNISWAP_V4_POOL_MANAGER.base)])).toBe(false);
    // „Zap“: Swap + Liquidität hinzufügen in derselben Tx → kein Verkauf
    const ml = { address: UNISWAP_V4_POOL_MANAGER.base, topics: [V4_MODIFY_LIQUIDITY_TOPIC, `0x${'ab'.repeat(32)}`, padTopic(ROUTER)] };
    expect(v4SwapIn('base', [ev(UNISWAP_V4_POOL_MANAGER.base), ml])).toBe(false);
  });

  it('natives ETH ↔ Stablecoin ist kein Token-Handel', () => {
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0xde0b6b3a7640000' }, [transfer(USDC, POOL, ME, 3000n)], ME, dec, null)).toBeNull();
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(USDC, ME, POOL, 3000n)], ME, dec, null, 10n)).toBeNull();
  });

  it('Stablecoin als Gegenseite: USDC → Meme = Kauf, Meme → USDC = Verkauf, Meme ↔ Meme = kein Swap', () => {
    const s = deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(USDC, ME, POOL, 100n), transfer(MEME, POOL, ME, 9n)], ME, dec, null);
    expect(s).toMatchObject({ side: 'buy', token: MEME, counterToken: USDC, nativeAtomic: null });
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n), transfer(USDC, POOL, ME, 100n)], ME, dec, null)).toMatchObject({ side: 'sell', token: MEME, tokenAtomic: 9n, counterToken: USDC });
    const OTHER = '0x8888888888888888888888888888888888888888';
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n), transfer(OTHER, POOL, ME, 5n)], ME, dec, null)).toBeNull();
  });

  it('kein Swap: Überweisung an Freund, Airdrop, NFT, Null-Betrag', () => {
    // Überweisung: Tx geht direkt an den Token-Vertrag
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: MEME, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null)).toBeNull();
    // Airdrop: Token rein, jemand anderes hat die Tx gesendet, nichts bezahlt
    expect(deriveEvmSwap('base', '0xabc', { from: POOL, to: MEME, value: '0x0' }, [transfer(MEME, POOL, ME, 9n)], ME, dec, null)).toBeNull();
    // Token raus, aber von jemand anderem ausgelöst (z. B. transferFrom nach Freigabe) → nicht als eigener Verkauf deuten
    expect(deriveEvmSwap('base', '0xabc', { from: POOL, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null)).toBeNull();
    // NFT (ERC-721: 4 Topics, kein data)
    const nft: EvmLog = { address: MEME, topics: [ERC20_TRANSFER_TOPIC, padTopic(POOL), padTopic(ME), '0x01'], data: '0x', transactionHash: '0xabc', blockNumber: '0x10' };
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x2386f26fc10000' }, [nft], ME, dec, null)).toBeNull();
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x1' }, [transfer(MEME, POOL, ME, 0n)], ME, dec, null)).toBeNull();
  });
});

describe('Logs-RPC-Auswahl', () => {
  it('eigener Logs-RPC, dann eigener RPC, dann öffentliche Liste — ohne Doppelte', () => {
    expect(logRpcCandidates('base', {})).toEqual(EVM_LOG_RPCS.base);
    expect(logRpcCandidates('base', { RPC_URL_BASE: 'https://mein-knoten', RPC_URL_LOGS_BASE: 'https://logs-knoten' })).toEqual(['https://logs-knoten', 'https://mein-knoten', ...EVM_LOG_RPCS.base]);
    expect(logRpcCandidates('base', { RPC_URL_BASE: EVM_LOG_RPCS.base[0] })).toEqual(EVM_LOG_RPCS.base);
  });

  it('RPC lehnt adressfreie Logs ab → nächster Endpunkt; keiner → ehrlicher Fehler mit Hinweis', async () => {
    const used: string[] = [];
    const net = (refuse: (url: string) => boolean) =>
      (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        used.push(`${new URL(url).host}:${body.method}`);
        const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
        if (body.method === 'eth_blockNumber') return rpc('0x1000');
        if (body.method === 'eth_getLogs') {
          return refuse(url) ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Please specify an address in your request' } })) : rpc([]);
        }
        return rpc(null);
      }) as unknown as typeof fetch;
    const prev = { ...process.env };
    delete process.env.RPC_URL_ARBITRUM;
    delete process.env.RPC_URL_LOGS_ARBITRUM;
    try {
      const first = new URL(EVM_LOG_RPCS.arbitrum[0]!).host;
      const r = await fetchEvmWalletSwaps('arbitrum', ME, {}, net((u) => new URL(u).host === first));
      expect(r).toEqual({ swaps: [], newestSignature: String(0x1000 - 3), gap: false }); // 3 Bestätigungen
      expect(used.some((u) => u.startsWith(first))).toBe(true);
      // der funktionierende Endpunkt wird gemerkt → nächster Abruf fragt ihn zuerst
      used.length = 0;
      await fetchEvmWalletSwaps('arbitrum', ME, {}, net((u) => new URL(u).host === first));
      expect(used[0]!.startsWith(new URL(EVM_LOG_RPCS.arbitrum[1]!).host)).toBe(true);

      await expect(fetchEvmWalletSwaps('arbitrum', ME, {}, net(() => true))).rejects.toThrow(/RPC_URL_LOGS_ARBITRUM/);
    } finally {
      process.env = prev;
    }
  });
});

describe('Drosselung', () => {
  it('HTTP 429 → genau ein zweiter Versuch, dann weiter', async () => {
    setEvmRetryDelayForTests(0);
    let calls = 0;
    const net = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      calls++;
      if (body.method === 'eth_blockNumber' && calls === 1) return new Response('zu viele', { status: 429 });
      const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      return body.method === 'eth_blockNumber' ? rpc('0x20') : rpc([]);
    }) as unknown as typeof fetch;
    try {
      await expect(fetchEvmWalletSwaps('bsc', ME, {}, net)).resolves.toEqual({ swaps: [], newestSignature: String(0x20 - 3), gap: false });
      expect(calls).toBe(4); // 429, Blocknummer, Logs raus, Logs rein
    } finally {
      setEvmRetryDelayForTests(null);
    }
  });
});

describe('lückenlos nachholen', () => {
  // 5 Käufe in den Blöcken 101..105 (je ein Tx), aktueller Block 110
  const buys = [101, 102, 103, 104, 105].map((b) => ({ ...transfer(MEME, POOL, ME, BigInt(b)), transactionHash: `0x${b}`, blockNumber: `0x${b.toString(16)}`, logIndex: '0x0' }));
  const net = (logs: EvmLog[], latest = 110) =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      switch (body.method) {
        case 'eth_blockNumber':
          return rpc(`0x${latest.toString(16)}`);
        case 'eth_getLogs': {
          const f = body.params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] };
          const incoming = f.topics[1] === null;
          return rpc(incoming ? logs.filter((l) => BigInt(l.blockNumber) >= BigInt(f.fromBlock) && BigInt(l.blockNumber) <= BigInt(f.toBlock)) : []);
        }
        case 'eth_getTransactionByHash':
          return rpc({ from: ME, to: ROUTER, value: '0x1' });
        case 'eth_getTransactionReceipt':
          return rpc({ logs: [] });
        case 'eth_getBlockByNumber':
          return rpc({ timestamp: '0x1' });
        case 'eth_call':
          return rpc(`0x${'12'.padStart(64, '0')}`);
      }
      return rpc(null);
    }) as unknown as typeof fetch;

  it('mehr neue Tx als erlaubt → die ältesten zuerst, Cursor davor, Rest im nächsten Abruf; nichts fehlt', async () => {
    const r1 = await fetchEvmWalletSwaps('base', ME, { cursor: '100', maxTxs: 2 }, net(buys));
    expect(r1.swaps.map((s) => s.signature)).toEqual(['0x102', '0x101']);
    expect(r1).toMatchObject({ newestSignature: '102', gap: false });
    const r2 = await fetchEvmWalletSwaps('base', ME, { cursor: r1.newestSignature, maxTxs: 2 }, net(buys));
    expect(r2.swaps.map((s) => s.signature)).toEqual(['0x104', '0x103']);
    const r3 = await fetchEvmWalletSwaps('base', ME, { cursor: r2.newestSignature, maxTxs: 2 }, net(buys));
    expect(r3).toMatchObject({ newestSignature: '107', gap: false }); // Spitze 110 − 3 Bestätigungen
    expect(r3.swaps.map((s) => s.signature)).toEqual(['0x105']);
  });

  it('Knoten hängt hinterher (Spitze ≤ Cursor) → Cursor bleibt, nichts doppelt', async () => {
    const r = await fetchEvmWalletSwaps('base', ME, { cursor: '108', maxTxs: 5 }, net(buys, 110));
    expect(r).toEqual({ swaps: [], newestSignature: '108', gap: false });
  });

  it('erster Lauf: nur die jüngsten als Verlauf; Cursor weit hinter dem Fenster → Lücke gemeldet', async () => {
    const first = await fetchEvmWalletSwaps('base', ME, { maxTxs: 2 }, net(buys));
    expect(first.swaps.map((s) => s.signature)).toEqual(['0x105', '0x104']);
    expect(first.newestSignature).toBe('107');
    const behind = await fetchEvmWalletSwaps('base', ME, { cursor: '10', maxBlocks: 50 }, net(buys));
    expect(behind.gap).toBe(true);
  });
});

/**
 * Echte Daten: öffentliche Knoten drosseln (HTTP 408/429/5xx) und erholen sich binnen Sekunden —
 * das ist kein Befund über unseren Code (CI 2026-10-22: alle fünf Base-Knoten gleichzeitig gedrosselt).
 * Bis zu drei Anläufe mit Pause; ein Fehler ohne Drossel-Status wirft sofort.
 */
async function retryWhenThrottled<T>(fn: () => Promise<T>, tries = 3, pauseMs = 20_000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof Error) || !/HTTP (408|429|5\d\d)/.test(e.message) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  throw last;
}

describe('echte Daten (Base-RPC)', () => {
  it('liest echte Transfer-Logs einer aktiven Adresse; Cursor = aktuelle Blocknummer, erkannte Swaps vollständig', async () => {
    // Uniswap Universal Router auf Base: garantiert laufend Token-Transfers
    const r = await retryWhenThrottled(() => fetchEvmWalletSwaps('base', '0x6fF5693b99212Da76ad316178A184AB56D299b43', { maxBlocks: 20, maxTxs: 4 }));
    expect(r.newestSignature).toMatch(/^\d+$/);
    expect(Number(r.newestSignature)).toBeGreaterThan(20_000_000);
    for (const s of r.swaps) {
      expect(['buy', 'sell']).toContain(s.side);
      expect(s.token).toMatch(/^0x[0-9a-f]{40}$/);
      expect(s.tokenDecimals).toBeGreaterThanOrEqual(0);
    }
    // Cursor = aktueller Block → nächster Abruf liest nichts doppelt
    const again = await retryWhenThrottled(() => fetchEvmWalletSwaps('base', '0x6fF5693b99212Da76ad316178A184AB56D299b43', { cursor: r.newestSignature, maxBlocks: 20, maxTxs: 4 }));
    expect(again.swaps.every((s) => !r.swaps.some((x) => x.signature === s.signature))).toBe(true);
  }, 150_000);

  it('Uniswap-v4-PoolManager auf Base meldet laufend Swap-Ereignisse mit genau unserer Signatur (Adresse + Topic stimmen)', async () => {
    const pm = UNISWAP_V4_POOL_MANAGER.base;
    const post = async (method: string, params: unknown[]) => {
      for (const url of EVM_LOG_RPCS.base) {
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          const body = (await res.json()) as { result?: unknown };
          if (res.ok && body.result !== undefined) return body.result;
        } catch {
          // nächster öffentlicher Knoten
        }
      }
      throw new Error(`kein Base-RPC beantwortet ${method}`);
    };
    const head = BigInt((await post('eth_blockNumber', [])) as string);
    const logs = (await post('eth_getLogs', [{ address: pm, topics: [V4_SWAP_TOPIC], fromBlock: `0x${(head - 200n).toString(16)}`, toBlock: `0x${head.toString(16)}` }])) as { address: string; topics: string[] }[];
    expect(logs.length).toBeGreaterThan(0);
    expect(v4SwapIn('base', logs)).toBe(true);
  }, 60_000);

  it('Dev-Verkauf-Schutz: echte ausgehende USDC-Transfers des Universal Routers, Cursor lückenlos', async () => {
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const UR = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
    const start = await fetchTokenOutflows('base', USDC, UR, null);
    expect(start.transfers).toEqual([]);
    let head = BigInt(start.cursor);
    expect(head).toBeGreaterThan(20_000_000n);
    // Fenster von 40 Blöcken (~80 s; manche Knoten erlauben höchstens 50): der Router gibt laufend USDC aus.
    // Ruhige Minuten kommen vor (CI-Befunde 2026-10-21/22: 0 Transfers in 80 s bzw. 160 s) → erst rückwärts
    // das Fenster schrittweise auf 200 Blöcke (~7 min) weiten (Knoten, die weniger erlauben, reicht die
    // Kandidatenliste weiter), dann bis zu vier Mal auf frische Blöcke warten. Die Behauptung bleibt hart.
    let page = await fetchTokenOutflows('base', USDC, UR, head - 40n);
    expect(BigInt(page.cursor)).toBeGreaterThanOrEqual(head);
    for (let back = 2n; page.transfers.length === 0 && back <= 5n; back++) {
      page = await fetchTokenOutflows('base', USDC, UR, head - 40n * back);
      expect(BigInt(page.cursor)).toBeGreaterThanOrEqual(head);
    }
    for (let attempt = 0; page.transfers.length === 0 && attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, 20_000));
      head = BigInt((await fetchTokenOutflows('base', USDC, UR, null)).cursor);
      page = await fetchTokenOutflows('base', USDC, UR, head - 40n);
    }
    expect(page.transfers.length).toBeGreaterThan(0);
    for (const t of page.transfers) {
      expect(t.to).toMatch(/^0x[0-9a-f]{40}$/);
      expect(t.amount).toBeGreaterThanOrEqual(0n);
      expect(t.tx).toMatch(/^0x[0-9a-f]{64}$/);
    }
    // Swaps des Routers prägen ihm keine LP-Token → echte Belege, keine Liquidität
    const lp = await liquidityMintTxs('base', page.transfers.slice(0, 3).map((t) => t.tx), UR);
    expect(lp.size).toBe(0);
  }, 180_000);
});
