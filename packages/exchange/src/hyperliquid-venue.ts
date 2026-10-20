import ccxt from 'ccxt';
import { verifyAgentWallet, type AgentCheck } from './hyperliquid-agent.js';
import { stepFromPrecision, type MarketRules, type TradingVenue, type VenueOrderRequest, type VenueOrderResult, type VenuePosition } from './venue.js';

/**
 * Hyperliquid-TESTNET (06_ §3) — erster DEX-Adapter, via ccxt.
 *
 * Sicherheitsmodell (Blueprint-Kernregel): Es wird AUSSCHLIESSLICH mit einer
 * API-/Agent-Wallet gearbeitet, die auf Hyperliquid nativ NUR handeln,
 * aber NICHT auszahlen kann. Patrick erzeugt die Agent-Wallet selbst
 * (app.hyperliquid-testnet.xyz → API → Agent-Wallet) und hinterlegt:
 *   HYPERLIQUID_TESTNET_WALLET  = Adresse der Haupt-Wallet (public)
 *   HYPERLIQUID_TESTNET_AGENT_KEY = Private Key der AGENT-Wallet (nie der Haupt-Wallet!)
 * Ohne diese Werte meldet validate() ehrlich „nicht verbunden".
 * Dieser Adapter hat — wie alle — keinerlei Auszahlungs-Codepfad.
 */
export class HyperliquidTestnetVenue implements TradingVenue {
  readonly id = 'hyperliquid-testnet';
  readonly kind = 'testnet' as const;

  private exchange: InstanceType<typeof ccxt.hyperliquid> | null = null;
  private readonly creds: { wallet: string; agentKey: string } | null = null;
  /** Ergebnis der Agent-Prüfung — Orders erst, wenn sie bestanden ist. */
  private agentCheck: AgentCheck | null = null;

  constructor(
    walletAddress?: string,
    agentPrivateKey?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    if (walletAddress && agentPrivateKey) {
      this.creds = { wallet: walletAddress, agentKey: agentPrivateKey };
      this.exchange = new ccxt.hyperliquid({
        walletAddress,
        privateKey: agentPrivateKey,
        enableRateLimit: true,
      });
      this.exchange.setSandboxMode(true);
    }
  }

  get configured(): boolean {
    return this.exchange !== null;
  }

  private ex(): InstanceType<typeof ccxt.hyperliquid> {
    if (!this.exchange) throw new Error('Hyperliquid-Testnet nicht konfiguriert (Agent-Wallet fehlt).');
    return this.exchange;
  }

  /** Hyperliquid-Perps heißen in ccxt z. B. "BTC/USDC:USDC" — Symbole werden gemappt. */
  static mapSymbol(symbol: string): string {
    const base = symbol.split('/')[0]!;
    return `${base}/USDC:USDC`;
  }

  async validate(): Promise<{ ok: boolean; detail: string }> {
    if (!this.exchange) {
      return {
        ok: false,
        detail: 'nicht verbunden — HYPERLIQUID_TESTNET_WALLET/_AGENT_KEY fehlen (Agent-Wallet legt Patrick an).',
      };
    }
    // Erst beweisen, dass der Key ein freigegebener AGENT der Haupt-Wallet ist
    // (öffentliche Info-API `userRole`) — der Haupt-Wallet-Key wird verweigert.
    const check = await this.verifyAgent();
    if (!check.ok) return { ok: false, detail: check.detail };
    try {
      await this.exchange.fetchBalance();
      return { ok: true, detail: `Hyperliquid-Testnet erreichbar. ${check.detail}` };
    } catch (err) {
      return { ok: false, detail: `Hyperliquid-Testnet-Zugang fehlgeschlagen: ${String(err)}` };
    }
  }

  /** Agent-Prüfung (gecacht, solange bestanden; Fehlschläge werden neu geprüft). */
  async verifyAgent(): Promise<AgentCheck> {
    if (!this.creds) throw new Error('Hyperliquid-Testnet nicht konfiguriert (Agent-Wallet fehlt).');
    if (this.agentCheck?.ok) return this.agentCheck;
    this.agentCheck = await verifyAgentWallet(this.creds.wallet, this.creds.agentKey, 'testnet', this.fetchFn);
    return this.agentCheck;
  }

  async marketRules(symbol: string): Promise<MarketRules> {
    const ex = this.ex();
    await ex.loadMarkets();
    const m = ex.market(HyperliquidTestnetVenue.mapSymbol(symbol));
    const tickSizeMode = ex.precisionMode === ccxt.TICK_SIZE;
    return {
      tickSize: stepFromPrecision(m.precision?.price, tickSizeMode, 0.01),
      lotSize: stepFromPrecision(m.precision?.amount, tickSizeMode, 0.0001),
      minNotional: Number(m.limits?.cost?.min ?? 10),
    };
  }

  async markPrice(symbol: string): Promise<number> {
    const t = await this.ex().fetchTicker(HyperliquidTestnetVenue.mapSymbol(symbol));
    const price = t.last ?? t.close;
    if (typeof price !== 'number') throw new Error(`Kein Preis für ${symbol}.`);
    return price;
  }

  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    const ex = this.ex();
    const check = await this.verifyAgent();
    if (!check.ok) throw new Error(`Hyperliquid-Order verweigert: ${check.detail}`);
    const hlSymbol = HyperliquidTestnetVenue.mapSymbol(req.symbol);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const params: Record<string, unknown> = { clientOrderId: req.clientOrderId };
        if (req.reduceOnly) params.reduceOnly = true;
        const type = 'market';
        if (req.type !== 'market') {
          // Hyperliquid: Trigger-Orders als stopLossPrice/takeProfitPrice-Market
          params.triggerPrice = req.triggerPrice;
          if (req.type === 'stop_market') params.stopLossPrice = req.triggerPrice;
          else params.takeProfitPrice = req.triggerPrice;
        }
        const o = await ex.createOrder(hlSymbol, type, req.side, req.qty, undefined, params);
        return {
          clientOrderId: req.clientOrderId,
          exchangeOrderId: String(o.id),
          status: o.status === 'closed' ? 'filled' : 'open',
          fillPrice: typeof o.average === 'number' ? o.average : undefined,
          filledQty: typeof o.filled === 'number' ? o.filled : undefined,
          raw: o,
        };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`Hyperliquid-Order fehlgeschlagen nach 3 Versuchen: ${String(lastErr)}`);
  }

  async cancelOrder(symbol: string, exchangeOrderId: string): Promise<void> {
    await this.ex().cancelOrder(exchangeOrderId, HyperliquidTestnetVenue.mapSymbol(symbol));
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    const raw = await this.ex().fetchPositions();
    return raw
      .filter((p) => Math.abs(Number(p.contracts ?? 0)) > 0)
      .map((p) => ({
        symbol: String(p.symbol),
        direction: p.side === 'long' ? 'long' : 'short',
        qty: Math.abs(Number(p.contracts)),
        entryPrice: Number(p.entryPrice),
      }));
  }

  async fetchOpenOrders(symbol?: string): Promise<{ clientOrderId: string; exchangeOrderId: string }[]> {
    const raw = await this.ex().fetchOpenOrders(symbol ? HyperliquidTestnetVenue.mapSymbol(symbol) : undefined);
    return raw.map((o) => ({ clientOrderId: String(o.clientOrderId ?? ''), exchangeOrderId: String(o.id) }));
  }
}
