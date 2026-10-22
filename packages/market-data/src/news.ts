import { desc } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';

const { newsItems } = schema;

/**
 * News-Ingestion (09_ §3.6): echte RSS-Feeds (frei, kein Key) → news_items.
 * Kein LLM-Sentiment ohne Provider — Items werden roh und ehrlich gelistet.
 */

export const NEWS_FEEDS: { source: string; url: string }[] = [
  { source: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'cointelegraph', url: 'https://cointelegraph.com/rss' },
  // Patricks Mängelliste 2026-10-22, Punkt 7: mehr Quellen — alle öffentliche, offizielle RSS-Feeds.
  { source: 'decrypt', url: 'https://decrypt.co/feed' },
  { source: 'theblock', url: 'https://www.theblock.co/rss.xml' },
  { source: 'bitcoinmagazine', url: 'https://bitcoinmagazine.com/feed' },
];

export type ParsedNewsItem = {
  source: string;
  title: string;
  url: string;
  publishedAt: Date;
  summary: string | null;
};

function decodeEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'");
}

function textOf(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return null;
  let value = m[1]!.trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1]!.trim();
  return decodeEntities(value);
}

/** Regex-basierter RSS-2.0-Parser (bewusst ohne XML-Dependency; Items ohne Link/Datum verworfen). */
export function parseRssFeed(xml: string, source: string): ParsedNewsItem[] {
  const items: ParsedNewsItem[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>|<item>[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = textOf(block, 'title');
    const url = textOf(block, 'link');
    const pubDate = textOf(block, 'pubDate');
    if (!title || !url || !pubDate) continue;
    const publishedAt = new Date(pubDate);
    if (Number.isNaN(publishedAt.getTime())) continue;
    const rawSummary = textOf(block, 'description');
    const summary = rawSummary ? decodeEntities(rawSummary.replace(/<[^>]+>/g, '').trim()).slice(0, 500) || null : null;
    items.push({ source, title, url, publishedAt, summary });
  }
  return items;
}

export type NewsSyncResult = { fetched: number; inserted: number; errors: string[] };

/** Holt alle Feeds; Dedupe über die eindeutige URL. */
export async function syncNews(db: Db): Promise<NewsSyncResult> {
  const result: NewsSyncResult = { fetched: 0, inserted: 0, errors: [] };
  for (const feed of NEWS_FEEDS) {
    try {
      const res = await fetch(feed.url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseRssFeed(await res.text(), feed.source);
      result.fetched += items.length;
      for (const item of items) {
        const inserted = await db
          .insert(newsItems)
          .values(item)
          .onConflictDoNothing({ target: newsItems.url })
          .returning({ id: newsItems.id });
        if (inserted.length > 0) result.inserted++;
      }
    } catch (err) {
      result.errors.push(`${feed.source}: ${String(err)}`);
    }
  }
  return result;
}

export async function latestNews(db: Db, limit = 50) {
  return db.select().from(newsItems).orderBy(desc(newsItems.publishedAt)).limit(limit);
}
