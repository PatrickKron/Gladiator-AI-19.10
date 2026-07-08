/**
 * Pure Demo-Fill-Engine (Session 5): simuliert Ausführung gegen ein ECHTES
 * Orderbuch. Spread und Slippage entstehen deterministisch aus der echten
 * Buchtiefe — kein Zufall, kein Modell. Nur die Ausführung ist simuliert;
 * die Preise sind real. Dieses Modul kennt weder DB noch Venue: der
 * Demo-Pfad kann bauartbedingt keine echten Orders auslösen.
 */

export const DEMO_START_BALANCE = 100_000;
/** Gebühren nach Patricks Binance-Beispiel: Maker 0,10 % / Taker 0,15 %. */
export const DEMO_MAKER_FEE = 0.001;
export const DEMO_TAKER_FEE = 0.0015;
/** Funding wie das bestehende Paper-Kostenmodell (executor.ts). */
export const DEMO_FUNDING_PER_8H = 0.0001;

export type BookLevel = { price: number; qty: number };

/** Echtes Orderbuch: bids absteigend, asks aufsteigend sortiert. */
export type OrderBookSnapshot = {
  symbol: string;
  ts: number;
  bids: BookLevel[];
  asks: BookLevel[];
};

export type FillResult = {
  filledQty: number;
  /** Volumengewichteter Fill-Preis über die konsumierten Level. */
  avgPrice: number;
  notional: number;
  fee: number;
  feeRole: 'maker' | 'taker';
  /**
   * Ausgewiesene Kosten ggü. Mid-Preis (Spread + Tiefe), in Quote-Währung.
   * VORZEICHEN: positiv = Kosten, negativ = Preisverbesserung. NUR Reporting:
   * die Slippage steckt bereits im avgPrice und darf beim Netto-PnL nicht
   * noch einmal abgezogen werden.
   */
  slippageVsMid: number;
};

export function midPrice(book: OrderBookSnapshot): number | null {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (bid === undefined || ask === undefined) return null;
  return (bid + ask) / 2;
}

/**
 * Läuft durch die Level, bis die Menge gefüllt ist oder (optional) ein Level
 * die Limit-Grenze reißt. Gibt ehrlich zurück, was die sichtbare Tiefe hergibt.
 */
export function walkBook(
  levels: BookLevel[],
  qty: number,
  opts: { side: 'buy' | 'sell'; limitPrice?: number } = { side: 'buy' },
): { filledQty: number; notional: number } {
  let remaining = qty;
  let notional = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    if (opts.limitPrice !== undefined) {
      const beyond = opts.side === 'buy' ? level.price > opts.limitPrice : level.price < opts.limitPrice;
      if (beyond) break;
    }
    const take = Math.min(remaining, level.qty);
    notional += take * level.price;
    remaining -= take;
  }
  return { filledQty: qty - remaining, notional };
}

function toFill(
  book: OrderBookSnapshot,
  side: 'buy' | 'sell',
  walked: { filledQty: number; notional: number },
  feeRole: 'maker' | 'taker',
): FillResult | null {
  if (walked.filledQty <= 0) return null;
  const avgPrice = walked.notional / walked.filledQty;
  const mid = midPrice(book);
  const feeRate = feeRole === 'maker' ? DEMO_MAKER_FEE : DEMO_TAKER_FEE;
  // Kosten-Konvention: Buy teurer als Mid = positiv, Sell billiger als Mid = positiv.
  const slippageVsMid = mid === null ? 0 : (side === 'buy' ? avgPrice - mid : mid - avgPrice) * walked.filledQty;
  return {
    filledQty: walked.filledQty,
    avgPrice,
    notional: walked.notional,
    fee: walked.notional * feeRate,
    feeRole,
    slippageVsMid,
  };
}

/** Market-Order: konsumiert die Gegenseite des Buchs (Taker). */
export function simulateMarketFill(book: OrderBookSnapshot, side: 'buy' | 'sell', qty: number): FillResult | null {
  const levels = side === 'buy' ? book.asks : book.bids;
  return toFill(book, side, walkBook(levels, qty, { side }), 'taker');
}

/**
 * Limit-Order bei Platzierung: kreuzt sie das Buch, füllt sie sofort als
 * Taker gegen die Level bis zur Limit-Grenze (echte Preisverbesserung:
 * bezahlt werden die Level-Preise, nicht das Limit). Der Rest ruht.
 */
export function simulateLimitPlacement(
  book: OrderBookSnapshot,
  side: 'buy' | 'sell',
  qty: number,
  limitPrice: number,
): { fill: FillResult | null; restingQty: number } {
  const levels = side === 'buy' ? book.asks : book.bids;
  const fill = toFill(book, side, walkBook(levels, qty, { side, limitPrice }), 'taker');
  return { fill, restingQty: qty - (fill?.filledQty ?? 0) };
}

/**
 * Ruhende Limit-Order im Monitor-Tick: handelt der Markt durch das Limit
 * (sichtbare Gegenseiten-Menge auf/hinter dem Limit-Preis), füllt sie
 * ZUM LIMIT-PREIS als Maker — partiell, begrenzt durch die sichtbare Tiefe.
 */
export function restingLimitFill(
  book: OrderBookSnapshot,
  side: 'buy' | 'sell',
  remainingQty: number,
  limitPrice: number,
): FillResult | null {
  const levels = side === 'buy' ? book.asks : book.bids;
  const available = walkBook(levels, remainingQty, { side, limitPrice }).filledQty;
  if (available <= 0) return null;
  return toFill(book, side, { filledQty: available, notional: available * limitPrice }, 'maker');
}

/**
 * SL/TP-Trigger gegen den ausführbaren Preis: Long schließt per Sell
 * (Best-Bid zählt), Short per Buy (Best-Ask zählt). Leeres Buch = kein
 * Preis = kein Trigger (ehrlich, keine Aktion ohne Daten).
 */
export function checkTrigger(
  direction: 'long' | 'short',
  kind: 'stop' | 'takeProfit',
  triggerPrice: number,
  book: OrderBookSnapshot,
): boolean {
  const exec = direction === 'long' ? book.bids[0]?.price : book.asks[0]?.price;
  if (exec === undefined) return false;
  if (direction === 'long') {
    return kind === 'stop' ? exec <= triggerPrice : exec >= triggerPrice;
  }
  return kind === 'stop' ? exec >= triggerPrice : exec <= triggerPrice;
}

/**
 * Netto-Rechnung beim Schließen — gleiche Konvention wie das bestehende
 * Paper-Kostenmodell: netto = gross − Fees − Funding. Die Slippage steckt
 * bereits in den echten Fill-Preisen (kein Doppelabzug).
 */
export function computeCloseNumbers(input: {
  direction: 'long' | 'short';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryFee: number;
  exitFee: number;
  hoursHeld: number;
}): { grossPnl: number; funding: number; netPnl: number } {
  const sign = input.direction === 'long' ? 1 : -1;
  const grossPnl = (input.exitPrice - input.entryPrice) * input.qty * sign;
  const funding = input.entryPrice * input.qty * DEMO_FUNDING_PER_8H * (Math.max(0, input.hoursHeld) / 8);
  return { grossPnl, funding, netPnl: grossPnl - input.entryFee - input.exitFee - funding };
}

/** Verfügbar = Balance − gebundene Notional (offene Positionen + ruhende Entry-Orders), nie negativ. */
export function availableBalance(balance: number, openPositionsNotional: number, restingEntryNotional: number): number {
  return Math.max(0, balance - openPositionsNotional - restingEntryNotional);
}

/** Volumengewichtetes Mitteln beim Aufstocken einer Position. */
export function addToPosition(
  existing: { qty: number; entryPrice: number },
  fill: { qty: number; price: number },
): { qty: number; entryPrice: number } {
  const qty = existing.qty + fill.qty;
  return { qty, entryPrice: (existing.qty * existing.entryPrice + fill.qty * fill.price) / qty };
}

/** Rundet ABWÄRTS auf die Schrittweite (lotSize/tickSize) — nie mehr als erlaubt. */
export function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  // Float-Toleranz: 1.234000000001 / 0.001 → 1234 statt 1233
  return Math.floor(value / step + 1e-9) * step;
}
