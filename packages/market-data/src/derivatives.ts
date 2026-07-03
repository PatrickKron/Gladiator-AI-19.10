import { and, desc, eq, gte, lte } from 'drizzle-orm';
import ccxt from 'ccxt';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';

const { fundingRates, openInterest } = schema;

/**
 * Derivate-Daten für den Shadow-Agenten (08_ §1): Funding-Rates + Open
 * Interest von Binance-Futures (öffentliche API, kein Key) → Hypertables.
 */

export const DERIVATIVE_SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'];

let exchange: InstanceType<typeof ccxt.binanceusdm> | null = null;
function ex(): InstanceType<typeof ccxt.binanceusdm> {
  if (!exchange) exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  return exchange;
}

/** Perp-Symbol → Spot-Notation der App (BTC/USDT:USDT → BTC/USDT). */
export function toAppSymbol(perp: string): string {
  return perp.split(':')[0]!;
}

export type DerivativesSyncResult = { funding: number; openInterest: number; errors: string[] };

export async function syncDerivatives(db: Db): Promise<DerivativesSyncResult> {
  const result: DerivativesSyncResult = { funding: 0, openInterest: 0, errors: [] };
  for (const perp of DERIVATIVE_SYMBOLS) {
    const symbol = toAppSymbol(perp);
    try {
      const fr = await ex().fetchFundingRate(perp);
      if (typeof fr.fundingRate === 'number' && fr.timestamp) {
        const inserted = await db
          .insert(fundingRates)
          .values({ venue: 'binanceusdm', symbol, ts: new Date(fr.timestamp), rate: String(fr.fundingRate) })
          .onConflictDoNothing()
          .returning({ ts: fundingRates.ts });
        result.funding += inserted.length;
      }
    } catch (err) {
      result.errors.push(`funding ${symbol}: ${String(err)}`);
    }
    try {
      const oi = await ex().fetchOpenInterest(perp);
      const value = oi.openInterestAmount ?? oi.openInterestValue;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const inserted = await db
          .insert(openInterest)
          .values({ venue: 'binanceusdm', symbol, ts: new Date(oi.timestamp ?? Date.now()), openInterest: String(value) })
          .onConflictDoNothing()
          .returning({ ts: openInterest.ts });
        result.openInterest += inserted.length;
      }
    } catch (err) {
      result.errors.push(`oi ${symbol}: ${String(err)}`);
    }
  }
  return result;
}

export type DerivativesSnapshot = {
  symbol: string;
  fundingRate: number | null;
  fundingTs: Date | null;
  openInterest: number | null;
  oiChangePct24h: number | null;
}[];

/** Letzter Stand je Symbol + 24h-OI-Änderung (nur aus echten gespeicherten Punkten). */
export async function getDerivativesSnapshot(db: Db, symbols = DERIVATIVE_SYMBOLS.map(toAppSymbol)): Promise<DerivativesSnapshot> {
  const out: DerivativesSnapshot = [];
  for (const symbol of symbols) {
    const [fr] = await db
      .select()
      .from(fundingRates)
      .where(and(eq(fundingRates.venue, 'binanceusdm'), eq(fundingRates.symbol, symbol)))
      .orderBy(desc(fundingRates.ts))
      .limit(1);
    const [oiNow] = await db
      .select()
      .from(openInterest)
      .where(and(eq(openInterest.venue, 'binanceusdm'), eq(openInterest.symbol, symbol)))
      .orderBy(desc(openInterest.ts))
      .limit(1);

    let oiChangePct24h: number | null = null;
    if (oiNow) {
      const dayAgo = new Date(oiNow.ts.getTime() - 24 * 3_600_000);
      const [oiPast] = await db
        .select()
        .from(openInterest)
        .where(
          and(
            eq(openInterest.venue, 'binanceusdm'),
            eq(openInterest.symbol, symbol),
            lte(openInterest.ts, dayAgo),
            gte(openInterest.ts, new Date(dayAgo.getTime() - 12 * 3_600_000)),
          ),
        )
        .orderBy(desc(openInterest.ts))
        .limit(1);
      if (oiPast && Number(oiPast.openInterest) > 0) {
        oiChangePct24h = (Number(oiNow.openInterest) / Number(oiPast.openInterest) - 1) * 100;
      }
    }

    out.push({
      symbol,
      fundingRate: fr ? Number(fr.rate) : null,
      fundingTs: fr?.ts ?? null,
      openInterest: oiNow ? Number(oiNow.openInterest) : null,
      oiChangePct24h,
    });
  }
  return out;
}

/** Frisch = jüngster Funding-Punkt < 3 h alt (Shadow-Agent-Datengrundlage). */
export async function derivativesFresh(db: Db): Promise<boolean> {
  const [fr] = await db.select().from(fundingRates).where(eq(fundingRates.venue, 'binanceusdm')).orderBy(desc(fundingRates.ts)).limit(1);
  return fr !== undefined && Date.now() - fr.ts.getTime() < 3 * 3_600_000;
}
