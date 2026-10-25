import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';

/**
 * News zu EINEM Asset (Mängelliste 7): echte RSS-Items, deren Titel den Basis-Ticker ODER
 * den Asset-Namen (assets-Tabelle, BTC ↔ „Bitcoin“) als GANZES Wort enthält — „ETH“ trifft
 * nicht „somETHing“. Neueste zuerst, höchstens `limit`. Ohne Treffer leer, nie geraten.
 * Asset-Register (2026-10-25): Yahoo-Symbole (SAP.DE, EURUSD=X, ^GSPC, GC=F) zählen ohne
 * ihre Zusätze, der Name kommt bevorzugt aus der Register-Zeile mit genau diesem Symbol.
 */
export type AssetNewsItem = { source: string; title: string; url: string; publishedAt: string };

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Postgres-Regex mit Wortgrenzen (\m … \M), Sonderzeichen des Begriffs entschärft. */
export function wordBoundaryRegex(term: string): string {
  return `\\m${escapeRe(term)}\\M`;
}

/** Rechtsform-/Füllwörter in Asset-Namen — Spiegel von apps/web/src/lib/newsMatch.ts (gleiche Regel, Server-Seite). */
const NAME_STOPWORDS = new Set(['inc', 'corp', 'corporation', 'company', 'co', 'ltd', 'plc', 'se', 'ag', 'nv', 'sa', 'the', 'and', 'of', 'class', 'shares', 'etf', 'trust', 'fund', 'index', 'group', 'holdings', 'holding', 'token', 'coin', 'usd', 'usdt', 'usdc']);

/**
 * Signifikante Namensteile als EINE zusammenhängende Wortfolge („Bitcoin Cash“ trifft nicht jede
 * „Cash“-Schlagzeile; „Newscoin Token“ → „Newscoin“). null, wenn nichts Signifikantes übrig bleibt.
 */
export function nameRegex(name: string): string | null {
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !NAME_STOPWORDS.has(w));
  if (words.length === 0 || (words.length === 1 && words[0]!.length < 2)) return null;
  return `\\m${words.map(escapeRe).join('[^[:alnum:]]+')}\\M`;
}

/**
 * Ticker für den Schlagzeilen-Abgleich: Basis eines Paars (BTC/USDT → BTC) bzw. Yahoo-Symbol ohne
 * Index-Präfix (^), Währungs-/Future-Zusatz (=X, =F) und Börsen-Suffix (.DE, .L) — Schlagzeilen
 * schreiben „SAP“, nie „SAP.DE“. Rein; der Abgleich bleibt ganzwortig.
 */
export function newsTicker(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const base = s.includes('/') ? s.split('/')[0]! : s;
  return base.replace(/^\^/, '').replace(/=[XF]$/, '').replace(/\.[A-Z]{1,4}$/, '');
}

export async function assetNews(db: Db, symbol: string, limit = 6): Promise<AssetNewsItem[]> {
  const sym = symbol.toUpperCase();
  const base = newsTicker(sym);
  // Register-Zeile mit genau diesem Kerzen-Symbol zuerst, dann Katalog per Ticker/Paar.
  const named = await db.execute(
    sql`SELECT name FROM assets WHERE upper(data_symbol) = ${sym} OR upper(ticker) = ${base} OR upper(ticker) = ${sym} OR upper(trading_pair) = ${sym}
        ORDER BY (upper(data_symbol) = ${sym}) DESC NULLS LAST, id LIMIT 1`,
  );
  const assetName = (named.rows[0] as { name: string } | undefined)?.name ?? null;
  const nameRe = assetName ? nameRegex(assetName) : null;
  const byName = nameRe && nameRe !== wordBoundaryRegex(base.toLowerCase()) ? sql`OR title ~* ${nameRe}` : sql``;
  const rows = await db.execute(
    sql`SELECT source, title, url, published_at FROM news_items WHERE title ~* ${wordBoundaryRegex(base)} ${byName} ORDER BY published_at DESC LIMIT ${limit}`,
  );
  return (rows.rows as { source: string; title: string; url: string; published_at: string | Date }[]).map((n) => ({
    source: n.source,
    title: n.title,
    url: n.url,
    publishedAt: new Date(n.published_at).toISOString(),
  }));
}
