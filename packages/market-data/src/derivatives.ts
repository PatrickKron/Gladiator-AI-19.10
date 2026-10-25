import { and, desc, eq, gte, lte } from 'drizzle-orm';
import ccxt from 'ccxt';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';

const { fundingRates, openInterest } = schema;

/**
 * Derivate-Daten für den Shadow-Agenten (08_ §1): Funding-Rates + Open
 * Interest von Binance-Futures (öffentliche API, kein Key) → Hypertables.
 *
 * Synchronisiert werden die Basis-Perps BTC/ETH/SOL plus das Scan-Universum (Krypto-Favoriten),
 * geschnitten mit den USDⓈ-M-Perpetuals, die Binance WIRKLICH listet (Liste 6 h gemerkt). Ein
 * Paar ohne gleichnamigen Perp bekommt ehrlich „kein Perpetual-Markt" — nie eine Ersatz-Zahl.
 */

export const DERIVATIVE_SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'];
/** Obergrenze je Lauf (Universum max. 40 + Basis) — je Perp zwei öffentliche Abrufe. */
export const MAX_DERIVATIVE_PERPS = 45;

let exchange: InstanceType<typeof ccxt.binanceusdm> | null = null;
function ex(): InstanceType<typeof ccxt.binanceusdm> {
  if (!exchange) exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  return exchange;
}

/** Perp-Symbol → Spot-Notation der App (BTC/USDT:USDT → BTC/USDT). */
export function toAppSymbol(perp: string): string {
  return perp.split(':')[0]!;
}

/** App-Paar → gleichnamiger USDⓈ-M-Perp-Kandidat (BTC/USDT → BTC/USDT:USDT); sonst null. */
export function perpSymbolFor(appSymbol: string): string | null {
  const spot = toAppSymbol(appSymbol.trim().toUpperCase());
  const m = /^([A-Z0-9]{1,20})\/(USDT|USDC)$/.exec(spot);
  return m ? `${m[1]}/${m[2]}:${m[2]}` : null;
}

export type PerpMarketLike = { symbol?: string; swap?: boolean; linear?: boolean; inverse?: boolean; future?: boolean; settle?: string; active?: boolean };

/** Pur: ccxt-Märkte → Menge der aktiven linearen Perpetuals (USDT/USDC-Settle). */
export function filterLinearPerps(markets: Iterable<PerpMarketLike | undefined>): Set<string> {
  const out = new Set<string>();
  for (const m of markets) {
    if (!m?.symbol || m.swap !== true || m.linear !== true || m.active === false) continue;
    if (m.settle !== 'USDT' && m.settle !== 'USDC') continue;
    out.add(m.symbol);
  }
  return out;
}

/**
 * Pur: welche Perps synchronisiert werden — Basis zuerst, dann Kandidaten (App-Paare), die es
 * als Perp gibt. Perp-Liste unbekannt (Börse nicht erreichbar) ⇒ nur die festen Basis-Perps.
 */
export function selectDerivativePerps(candidates: string[], listed: Set<string> | null, max = MAX_DERIVATIVE_PERPS): string[] {
  if (listed === null) return [...DERIVATIVE_SYMBOLS];
  const out: string[] = [];
  for (const perp of [...DERIVATIVE_SYMBOLS, ...candidates.map(perpSymbolFor)]) {
    if (perp && listed.has(perp) && !out.includes(perp)) out.push(perp);
    if (out.length >= max) break;
  }
  return out;
}

const PERP_TTL_MS = 6 * 3_600_000;
/** Nach einem Fehler 5 min nicht erneut fragen — sonst kostet jede Chart-Ansicht einen Timeout. */
const PERP_FAIL_TTL_MS = 5 * 60_000;
let perpCache: { at: number; perps: Set<string> } | null = null;
let perpFailure: { at: number; error: Error } | null = null;

/** USDⓈ-M-Perps live von Binance (öffentlich), 6 h gemerkt. Fehler werden geworfen (5 min gemerkt), nie geraten. */
export async function listBinancePerps(fetchMarkets?: () => Promise<Iterable<PerpMarketLike | undefined>>, now = Date.now()): Promise<Set<string>> {
  if (perpCache && now - perpCache.at < PERP_TTL_MS) return perpCache.perps;
  if (perpFailure && now - perpFailure.at < PERP_FAIL_TTL_MS) throw perpFailure.error;
  try {
    const markets = fetchMarkets ? await fetchMarkets() : (Object.values(await ex().loadMarkets()) as PerpMarketLike[]);
    const perps = filterLinearPerps(markets);
    if (perps.size === 0) throw new Error('Binance lieferte keine Perpetual-Märkte (USDⓈ-M)');
    perpCache = { at: now, perps };
    perpFailure = null;
    return perps;
  } catch (err) {
    perpFailure = { at: now, error: err instanceof Error ? err : new Error(String(err)) };
    throw perpFailure.error;
  }
}

/** Nur für Tests. */
export function resetPerpCache(): void {
  perpCache = null;
  perpFailure = null;
}

export type DerivativesSyncResult = { funding: number; openInterest: number; perps: number; errors: string[] };

/**
 * Funding + OI je Perp. `candidates` = App-Paare (Scan-Universum aus @gladiator/jobs — der Worker
 * reicht sie herein, market-data darf jobs nicht importieren).
 */
export async function syncDerivatives(db: Db, candidates: string[] = [], listPerps: () => Promise<Set<string>> = () => listBinancePerps()): Promise<DerivativesSyncResult> {
  const result: DerivativesSyncResult = { funding: 0, openInterest: 0, perps: 0, errors: [] };
  let listed: Set<string> | null = null;
  try {
    listed = await listPerps();
  } catch (err) {
    result.errors.push(`perp-liste: ${String(err)} — nur Basis-Perps`);
  }
  const perps = selectDerivativePerps(candidates, listed);
  result.perps = perps.length;
  for (const perp of perps) {
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
