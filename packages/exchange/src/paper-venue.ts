import ccxt from 'ccxt';
import { withBinancePublic } from '@gladiator/market-data';
import { stepFromPrecision, type MarketRules, type TradingVenue, type VenueOrderRequest, type VenueOrderResult, type VenuePosition } from './venue.js';

/**
 * Interne Paper-Engine (06_ §7): füllt Market-Orders sofort zum ECHTEN
 * Live-Preis (Binance public REST — bei Standortsperre über den offiziellen
 * Marktdaten-Spiegel; keine Keys nötig, kein Geld, keine Fakes:
 * der Preis ist real, nur die Ausführung ist simuliert und als Paper markiert).
 * Stop/TP-Orders werden angenommen und vom PositionMonitor gegen echte
 * Live-Preise überwacht (minütlich, dokumentierte Granularität).
 * Zustand (Orders/Positionen) hält die DB — dieser Adapter ist bewusst dünn.
 */
export class PaperVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;

  private orderSeq = 0;
  private seenClientIds = new Map<string, VenueOrderResult>();

  async validate(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.markPrice('BTC/USDT');
      return { ok: true, detail: 'Paper-Engine aktiv — Fills gegen echte Binance-Live-Preise.' };
    } catch (err) {
      return { ok: false, detail: `Preisquelle nicht erreichbar: ${String(err)}` };
    }
  }

  async marketRules(symbol: string): Promise<MarketRules> {
    const { m, tickSizeMode } = await withBinancePublic(async (ex) => {
      await ex.loadMarkets();
      return { m: ex.market(symbol), tickSizeMode: ex.precisionMode === ccxt.TICK_SIZE };
    });
    return {
      tickSize: stepFromPrecision(m.precision?.price, tickSizeMode, 0.01),
      lotSize: stepFromPrecision(m.precision?.amount, tickSizeMode, 0.000001),
      minNotional: Number(m.limits?.cost?.min ?? 10),
    };
  }

  async markPrice(symbol: string): Promise<number> {
    const t = await withBinancePublic((ex) => ex.fetchTicker(symbol));
    const price = t.last ?? t.close;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new Error(`Kein echter Preis für ${symbol} verfügbar.`);
    }
    return price;
  }

  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    // Idempotenz: gleiche clientOrderId liefert dasselbe Ergebnis zurück
    const seen = this.seenClientIds.get(req.clientOrderId);
    if (seen) return seen;

    let result: VenueOrderResult;
    if (req.type === 'market') {
      const price = await this.markPrice(req.symbol);
      result = {
        clientOrderId: req.clientOrderId,
        exchangeOrderId: `paper-${Date.now()}-${++this.orderSeq}`,
        status: 'filled',
        fillPrice: price,
        filledQty: req.qty,
      };
    } else {
      if (req.triggerPrice === undefined) {
        return { clientOrderId: req.clientOrderId, exchangeOrderId: '', status: 'rejected' };
      }
      result = {
        clientOrderId: req.clientOrderId,
        exchangeOrderId: `paper-${Date.now()}-${++this.orderSeq}`,
        status: 'open',
      };
    }
    this.seenClientIds.set(req.clientOrderId, result);
    return result;
  }

  async cancelOrder(): Promise<void> {
    // Paper: Orders leben in der DB; der Executor setzt dort den Status.
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    // Paper: die DB ist die Wahrheit (kein externer Zustand zu reconcilen).
    return [];
  }

  async fetchOpenOrders(): Promise<{ clientOrderId: string; exchangeOrderId: string }[]> {
    return [];
  }
}
