import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { listSupportedExchanges, walletExchanges, type SupportedExchange } from './connections.js';

/**
 * Börsen-Erkennung aus dem Chat (Patrick: „durch den Chat soll die App wissen,
 * welche Börsen ich benutze, und sich darauf einstellen"). Deterministisch,
 * ohne LLM: CCXT-IDs/-Namen + wenige Aliase, mit Wortgrenzen. Ergebnis ist
 * nur ein VORSCHLAG (verbinden/bevorzugen) — nie eine automatische Aktion.
 */

/** Alltags- bzw. App-Wörter, die zufällig CCXT-IDs/-Namen sind → nie als Börse werten. */
const AMBIGUOUS = new Set([
  'gate', 'delta', 'derive', 'bullish', 'extended', 'lighter', 'aster', 'apex', 'backpack', 'aftermath',
  'gemini', 'pacifica', 'mercado', 'cex', 'xt', 'woo', 'luno', 'zaif', 'p2b', 'exmo', 'ndax', 'grvt',
]);

/** Gebräuchliche Namen, die CCXT anders führt. */
const ALIASES: Record<string, string> = {
  'gate.io': 'gate',
  'gateio': 'gate',
  'crypto.com': 'cryptocom',
  'huobi': 'htx',
  'coinbase': 'coinbase',
  'okex': 'okx',
  'kucoin': 'kucoin',
  'mexc': 'mexc',
  'bitget': 'bitget',
  'cex.io': 'cex',
  'woo x': 'woo',
};

export type ExchangeMention = { id: string; name: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function candidates(exchanges: SupportedExchange[]): { token: string; id: string }[] {
  const known = new Set(exchanges.map((e) => e.id));
  const out: { token: string; id: string }[] = [];
  for (const e of exchanges) {
    for (const raw of [e.id, e.name.toLowerCase()]) {
      const token = raw.trim();
      if (token.length < 3 || AMBIGUOUS.has(token)) continue;
      out.push({ token, id: e.id });
    }
  }
  for (const [token, id] of Object.entries(ALIASES)) if (known.has(id)) out.push({ token, id });
  return out;
}

/** Alle erwähnten Börsen in Reihenfolge der ersten Nennung; längster Treffer gewinnt bei Überlappung. */
export function detectExchangeMentions(text: string, exchanges: SupportedExchange[]): ExchangeMention[] {
  const lower = text.toLowerCase();
  const hits: { start: number; end: number; id: string }[] = [];
  for (const c of candidates(exchanges)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(c.token)}(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of lower.matchAll(re)) hits.push({ start: m.index!, end: m.index! + m[0].length, id: c.id });
  }
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: typeof hits = [];
  for (const h of hits) {
    if (accepted.some((a) => h.start < a.end && a.start < h.end)) continue;
    accepted.push(h);
  }
  accepted.sort((a, b) => a.start - b.start);
  const names = new Map(exchanges.map((e) => [e.id, e.name]));
  const seen = new Set<string>();
  const out: ExchangeMention[] = [];
  for (const h of accepted) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push({ id: h.id, name: names.get(h.id) ?? h.id });
  }
  return out;
}

export type PreferredExchange = ExchangeMention & { mentions: number; lastMentionedAt: Date };

/** Bevorzugte Börsen aus vielen Nachrichten: Häufigkeit (Nachrichten mit Nennung), dann Aktualität. */
export function rankPreferredExchanges(messages: { text: string; at: Date }[], exchanges: SupportedExchange[]): PreferredExchange[] {
  const acc = new Map<string, PreferredExchange>();
  for (const msg of messages) {
    for (const m of detectExchangeMentions(msg.text, exchanges)) {
      const cur = acc.get(m.id);
      if (cur) {
        cur.mentions++;
        if (msg.at > cur.lastMentionedAt) cur.lastMentionedAt = msg.at;
      } else {
        acc.set(m.id, { ...m, mentions: 1, lastMentionedAt: msg.at });
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.mentions - a.mentions || b.lastMentionedAt.getTime() - a.lastMentionedAt.getTime());
}

export type PreferredExchangeView = PreferredExchange & { connected: boolean; walletLogin: boolean };

/**
 * Bevorzugte Börsen des Users aus SEINEN eigenen Chat-Nachrichten (Workshop-
 * Dialog + Anweisungen, neueste 500) — eine Wahrheit, keine Zweit-Tabelle.
 * `connected` zeigt, ob dafür schon eine aktive Verbindung existiert.
 */
export async function loadPreferredExchanges(db: Db, userId: string): Promise<PreferredExchangeView[]> {
  const { workshopMessages, workshopSessions, exchangeConnections } = schema;
  const msgs = await db
    .select({ text: workshopMessages.content, at: workshopMessages.createdAt })
    .from(workshopMessages)
    .innerJoin(workshopSessions, eq(workshopMessages.sessionId, workshopSessions.id))
    .where(and(eq(workshopSessions.userId, userId), eq(workshopMessages.role, 'user')))
    .orderBy(desc(workshopMessages.createdAt))
    .limit(500);
  const instr = await db
    .select({ text: workshopSessions.instructions, at: workshopSessions.updatedAt })
    .from(workshopSessions)
    .where(eq(workshopSessions.userId, userId));
  const texts = [...msgs, ...instr.filter((i): i is { text: string; at: Date } => Boolean(i.text))];
  const ranked = rankPreferredExchanges(texts, listSupportedExchanges());
  const conns = await db
    .select({ exchangeId: exchangeConnections.exchangeId, status: exchangeConnections.status })
    .from(exchangeConnections)
    .where(eq(exchangeConnections.userId, userId));
  const active = new Set(conns.filter((c) => c.status !== 'revoked').map((c) => c.exchangeId));
  const wallet = new Set(walletExchanges().map((e) => e.id));
  return ranked.map((r) => ({ ...r, connected: active.has(r.id), walletLogin: wallet.has(r.id) }));
}
