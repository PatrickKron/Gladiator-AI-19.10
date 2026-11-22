/**
 * Reine Helfer für TradingView-Preislinien im Hauptchart:
 * - Offene Agenten-/Live-Positionen (Entry, SL, TP1/TP2…)
 * - Offene Demo-Positionen (Entry, SL, TP, Liquidation)
 * - Aktive Preis-Alerts (≥ / ≤)
 * Rein & unit-getestet; gerendert inkrementell ohne Chart-Neubau in AssetChart.tsx.
 */

export type OverlayLineStyle = 'solid' | 'dashed' | 'dotted';

export type ChartOverlayLine = {
  price: number;
  color: string;
  lineStyle: OverlayLineStyle;
  title: string;
  kind: 'entry' | 'sl' | 'tp' | 'liq' | 'alert';
};

export type AgentPositionOverlay = {
  symbol: string;
  candleVenue?: string | null;
  direction: 'long' | 'short';
  mode?: string;
  entryPrice: number;
  stopLoss?: { price: number } | null;
  takeProfits?: { price: number }[];
};

export type DemoPositionOverlay = {
  symbol: string;
  venue: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  liquidationPrice: number | null;
};

export type PriceAlertOverlay = {
  symbol: string;
  venue?: string | null;
  condition: string;
  price: string | number;
  active?: boolean;
  triggeredAt: string | Date | null;
  note?: string | null;
};

const STOCK_VENUES = new Set(['yahoo', 'twelvedata']);

/** Passt eine Positions-/Alert-Quelle zum aktuell geöffneten Chart-Venue? */
export function overlayVenueMatches(chartVenue: string, itemVenue: string | null | undefined, allowAnyCrypto = false): boolean {
  const cv = chartVenue.toLowerCase();
  const iv = (itemVenue ?? 'binance').toLowerCase();
  if (STOCK_VENUES.has(cv)) return iv === cv;
  if (allowAnyCrypto) return !STOCK_VENUES.has(iv);
  return iv === cv;
}

/** Automatische Alert-Bedingung beim Klick auf ein Preisniveau im Chart. */
export function alertConditionForPrice(targetPrice: number, currentPrice: number | null): 'above' | 'below' {
  if (currentPrice !== null && Number.isFinite(currentPrice) && currentPrice > 0) {
    return targetPrice >= currentPrice ? 'above' : 'below';
  }
  return 'above';
}

function validPrice(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildChartOverlayLines(input: {
  symbol: string;
  venue: string;
  agentPositions?: AgentPositionOverlay[];
  demoPositions?: DemoPositionOverlay[];
  alerts?: PriceAlertOverlay[];
}): ChartOverlayLine[] {
  const sym = input.symbol.trim().toUpperCase();
  const out: ChartOverlayLine[] = [];

  for (const p of input.agentPositions ?? []) {
    if (p.symbol.trim().toUpperCase() !== sym) continue;
    if (!overlayVenueMatches(input.venue, p.candleVenue, false)) continue;
    const prefix = p.mode === 'live' ? 'LIVE ' : '';
    const entry = validPrice(p.entryPrice);
    if (entry !== null) {
      out.push({
        price: entry,
        color: p.mode === 'live' ? '#f59e0b' : '#38bdf8',
        lineStyle: 'solid',
        title: `${prefix}${p.direction.toUpperCase()}`,
        kind: 'entry',
      });
    }
    const sl = validPrice(p.stopLoss?.price);
    if (sl !== null) {
      out.push({ price: sl, color: '#ef4444', lineStyle: 'dashed', title: `${prefix}SL`, kind: 'sl' });
    }
    (p.takeProfits ?? []).forEach((tp, idx) => {
      const price = validPrice(tp.price);
      if (price !== null) {
        out.push({ price, color: '#22c55e', lineStyle: 'dashed', title: `${prefix}TP${idx + 1}`, kind: 'tp' });
      }
    });
  }

  for (const d of input.demoPositions ?? []) {
    if (d.symbol.trim().toUpperCase() !== sym) continue;
    if (!overlayVenueMatches(input.venue, d.venue, true)) continue;
    const entry = validPrice(d.entryPrice);
    if (entry !== null) {
      out.push({
        price: entry,
        color: '#60a5fa',
        lineStyle: 'solid',
        title: `Demo ${d.direction.toUpperCase()}`,
        kind: 'entry',
      });
    }
    const sl = validPrice(d.stopLoss);
    if (sl !== null) {
      out.push({ price: sl, color: '#ef4444', lineStyle: 'dashed', title: 'Demo SL', kind: 'sl' });
    }
    const tp = validPrice(d.takeProfit);
    if (tp !== null) {
      out.push({ price: tp, color: '#22c55e', lineStyle: 'dashed', title: 'Demo TP', kind: 'tp' });
    }
    const liq = validPrice(d.liquidationPrice);
    if (liq !== null) {
      out.push({ price: liq, color: '#f97316', lineStyle: 'dotted', title: 'Demo Liq', kind: 'liq' });
    }
  }

  for (const a of input.alerts ?? []) {
    if (a.triggeredAt !== null || a.active === false) continue;
    if (a.symbol.trim().toUpperCase() !== sym) continue;
    if (!overlayVenueMatches(input.venue, a.venue, false)) continue;
    const price = validPrice(a.price);
    if (price === null) continue;
    const arrow = a.condition === 'above' ? '≥' : '≤';
    const note = a.note?.trim();
    const title = note ? `🔔 ${arrow} ${note.slice(0, 14)}` : `🔔 Alert ${arrow}`;
    out.push({ price, color: '#f59e0b', lineStyle: 'dashed', title, kind: 'alert' });
  }

  return out;
}
