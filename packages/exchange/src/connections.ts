import ccxt from 'ccxt';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { decryptCredentials, encryptCredentials } from './vault.js';

const { exchangeConnections } = schema;

/**
 * Universelle Börsen-Anbindung über CCXT (100+ Börsen) — Patricks Auftrag:
 * „Jeder soll die Börse seines Vertrauens verbinden können. Egal ob EU,
 * Amerika, dies das jenes."
 *
 * Grundsätze:
 * - Verbindung wird beim Anlegen GEGEN DIE ECHTE BÖRSE bewiesen
 *   (fetchBalance + loadMarkets) — kein „gespeichert und gehofft".
 * - Keys liegen NUR Vault-verschlüsselt (AES-256-GCM) in der DB, Anzeige
 *   immer maskiert (last4).
 * - read_only ist der Default; trading schaltet nur die MÖGLICHKEIT frei —
 *   echte Live-Orders bleiben zusätzlich hinter Mensch-im-Loop + Freigabe-Gate.
 * - ccxt-Client ist injizierbar → Kern ohne Netz testbar (Repo-Muster).
 */

export type ExchangeCredentialsInput = {
  apiKey: string;
  secret: string;
  /** Manche Börsen (OKX, KuCoin, …) verlangen zusätzlich eine Passphrase. */
  password?: string;
  /** Manche Börsen (z. B. Bitmex-Subaccounts) nutzen eine uid. */
  uid?: string;
};

/** Wallet-Login (Hyperliquid & Co.): nur die ÖFFENTLICHE Adresse — nie ein Private Key. */
export type WalletCredentials = { walletAddress: string };

export type StoredCredentials = ExchangeCredentialsInput | WalletCredentials;

export type CcxtMarket = {
  symbol: string;
  base: string;
  quote: string;
  active?: boolean;
  contract?: boolean;
  limits?: { leverage?: { max?: number | null } | null } | null;
};

/** Minimales Client-Interface — genau das, was der Connector wirklich braucht. */
export type CcxtLikeClient = {
  loadMarkets(): Promise<Record<string, CcxtMarket>>;
  fetchBalance(): Promise<{ total?: Record<string, number>; free?: Record<string, number>; used?: Record<string, number> }>;
};

export type CreateClient = (exchangeId: string, creds: StoredCredentials) => CcxtLikeClient;

type CcxtConstructor = new (config: Record<string, unknown>) => CcxtLikeClient & { name?: string };
type CcxtModule = { exchanges: string[] } & Record<string, unknown>;

const ccxtModule = ccxt as unknown as CcxtModule;

/** Echter ccxt-Client (Produktion). requiredCredentials prüft ccxt selbst beim ersten privaten Call. */
export const defaultCreateClient: CreateClient = (exchangeId, creds) => {
  const Ctor = ccxtModule[exchangeId] as CcxtConstructor | undefined;
  if (!Ctor) throw new Error(`Börse "${exchangeId}" ist in CCXT nicht verfügbar.`);
  if ('walletAddress' in creds) return new Ctor({ walletAddress: creds.walletAddress, enableRateLimit: true });
  return new Ctor({
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.password ? { password: creds.password } : {}),
    ...(creds.uid ? { uid: creds.uid } : {}),
    enableRateLimit: true,
  });
};

export type SupportedExchange = { id: string; name: string };

let supportedCache: SupportedExchange[] | null = null;

/** Alle CCXT-Börsen (id + Anzeigename) — einmal ermittelt, dann gecacht. */
export function listSupportedExchanges(): SupportedExchange[] {
  if (supportedCache) return supportedCache;
  const out: SupportedExchange[] = [];
  for (const id of ccxtModule.exchanges) {
    const Ctor = ccxtModule[id] as CcxtConstructor | undefined;
    if (!Ctor) continue;
    try {
      const instance = new Ctor({});
      out.push({ id, name: typeof instance.name === 'string' && instance.name.length > 0 ? instance.name : id });
    } catch {
      // Börse ohne parameterlosen Konstruktor — ehrlich auslassen statt raten.
    }
  }
  supportedCache = out.sort((a, b) => a.name.localeCompare(b.name));
  return supportedCache;
}

export function isSupportedExchange(exchangeId: string): boolean {
  return ccxtModule.exchanges.includes(exchangeId);
}

/** EVM-Adresse: 0x + 40 Hex-Zeichen (Checksumme wird nicht verlangt, Vergleich klein geschrieben). */
export function isValidEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

let walletCache: SupportedExchange[] | null = null;

/**
 * Börsen, deren Konto an einer Wallet-Adresse statt an einem API-Key hängt
 * (laut CCXT requiredCredentials.walletAddress, z. B. Hyperliquid). Nur diese
 * lassen sich per öffentlicher Adresse NUR LESEND anschließen.
 */
export function walletExchanges(): SupportedExchange[] {
  if (walletCache) return walletCache;
  const out: SupportedExchange[] = [];
  for (const id of ccxtModule.exchanges) {
    const Ctor = ccxtModule[id] as CcxtConstructor | undefined;
    if (!Ctor) continue;
    try {
      const instance = new Ctor({}) as { name?: string; requiredCredentials?: Record<string, boolean> };
      const req = instance.requiredCredentials ?? {};
      if (req.walletAddress && !req.apiKey) out.push({ id, name: instance.name || id });
    } catch {
      // ohne parameterlosen Konstruktor ehrlich auslassen
    }
  }
  walletCache = out.sort((a, b) => a.name.localeCompare(b.name));
  return walletCache;
}

function maskAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export type MarketsSummary = {
  symbolCount: number;
  /** Handelbare unified Symbole ('BTC/USDT', 'BTC/USDT:USDT', …) — Basis für den Order-Router. */
  symbols: string[];
  quoteCurrencies: string[];
  baseAssets: string[];
  hasFutures: boolean;
  /** Höchster Hebel laut Markt-Limits; null wenn die Börse keinen ausweist. */
  maxLeverage: number | null;
};

/** Automatische Erkennung: welche Assets sind auf dieser Börse handelbar? (pur, testbar) */
export function summarizeMarkets(markets: Record<string, CcxtMarket>): MarketsSummary {
  const symbols: string[] = [];
  const quotes = new Set<string>();
  const bases = new Set<string>();
  let hasFutures = false;
  let maxLeverage: number | null = null;
  for (const m of Object.values(markets)) {
    if (m.active === false) continue; // inaktive Märkte sind nicht handelbar — ehrlich weglassen
    symbols.push(m.symbol);
    if (m.quote) quotes.add(m.quote);
    if (m.base) bases.add(m.base);
    if (m.contract) hasFutures = true;
    const lev = m.limits?.leverage?.max;
    if (typeof lev === 'number' && Number.isFinite(lev) && lev > (maxLeverage ?? 0)) maxLeverage = lev;
  }
  return {
    symbolCount: symbols.length,
    symbols: symbols.sort(),
    quoteCurrencies: [...quotes].sort(),
    baseAssets: [...bases].sort(),
    hasFutures,
    maxLeverage,
  };
}

/** 'BTCUSDT' → 'BTC/USDT'; 'BTC/USDT' bleibt. Nur für Router-Vergleiche. */
export function normalizeSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes('/')) return s;
  for (const quote of ['USDT', 'USDC', 'EUR', 'USD', 'BTC', 'ETH']) {
    if (s.endsWith(quote) && s.length > quote.length) return `${s.slice(0, -quote.length)}/${quote}`;
  }
  return s;
}

export type ConnectionForRouting = {
  id: string;
  exchangeId: string;
  mode: 'read_only' | 'trading';
  status: 'active' | 'error' | 'revoked';
  createdAt: Date;
  marketsSummary: MarketsSummary | null;
};

/**
 * Order-Router (pur): wählt automatisch die richtige verbundene Börse für ein Asset.
 * Regeln: nur aktive Trading-Verbindungen, Symbol muss dort handelbar sein
 * (unified Symbol inkl. Spot-Normalisierung), bei mehreren Treffern gewinnt
 * die älteste Verbindung (stabil, keine Überraschungen).
 */
export function pickConnectionForSymbol(connections: ConnectionForRouting[], symbol: string): ConnectionForRouting | null {
  const wanted = normalizeSymbol(symbol);
  const candidates = connections
    .filter((c) => c.status === 'active' && c.mode === 'trading' && c.marketsSummary)
    .filter((c) => {
      const symbols = c.marketsSummary!.symbols;
      // exakter unified Match ODER Perp-Variante ('BTC/USDT:USDT')
      return symbols.includes(wanted) || symbols.some((s) => s.startsWith(`${wanted}:`));
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return candidates[0] ?? null;
}

export type ConnectExchangeInput = {
  userId: string;
  exchangeId: string;
  label?: string;
  mode: 'read_only' | 'trading';
  credentials: ExchangeCredentialsInput;
};

export type ConnectionDto = {
  id: string;
  exchangeId: string;
  exchangeName: string;
  label: string | null;
  mode: 'read_only' | 'trading';
  status: 'active' | 'error' | 'revoked';
  /** api_key = klassische Börsen-Keys; wallet = nur öffentliche Adresse (immer read_only). */
  kind: 'api_key' | 'wallet';
  keyMasked: string;
  lastError: string | null;
  lastValidatedAt: Date | null;
  createdAt: Date;
  marketsSummary: MarketsSummary | null;
  maxLeverage: number | null;
};

/** Wallet-Verbindungen speichern statt last4 die maskierte Adresse ('0xabcd…1234'). */
function isWalletRow(row: { keyLast4: string }): boolean {
  return row.keyLast4.startsWith('0x');
}

function toDto(row: typeof exchangeConnections.$inferSelect): ConnectionDto {
  const wallet = isWalletRow(row);
  return {
    id: row.id,
    exchangeId: row.exchangeId,
    exchangeName: row.exchangeName,
    label: row.label,
    mode: row.mode,
    status: row.status,
    kind: wallet ? 'wallet' : 'api_key',
    keyMasked: wallet ? row.keyLast4 : `••••••••${row.keyLast4}`,
    lastError: row.lastError,
    lastValidatedAt: row.lastValidatedAt,
    createdAt: row.createdAt,
    marketsSummary: (row.marketsSummary as MarketsSummary | null) ?? null,
    maxLeverage: row.maxLeverage === null ? null : Number(row.maxLeverage),
  };
}

/**
 * Börse verbinden: Keys werden SOFORT gegen die echte Börse geprüft
 * (fetchBalance beweist Zugriff, loadMarkets liefert die Asset-Erkennung).
 * Erst nach Erfolg wird verschlüsselt gespeichert. Kein Fake, kein „später prüfen".
 */
export async function connectExchange(
  db: Db,
  input: ConnectExchangeInput,
  createClient: CreateClient = defaultCreateClient,
): Promise<ConnectionDto> {
  const exchangeId = input.exchangeId.trim().toLowerCase();
  if (!isSupportedExchange(exchangeId)) {
    throw new Error(`Börse "${exchangeId}" wird nicht unterstützt — bitte eine CCXT-Börse wählen.`);
  }
  const apiKey = input.credentials.apiKey.trim();
  const secret = input.credentials.secret.trim();
  if (apiKey.length < 8) throw new Error('API-Key zu kurz — bitte den vollständigen Key einfügen.');
  if (secret.length < 8) throw new Error('API-Secret zu kurz — bitte das vollständige Secret einfügen.');

  const client = createClient(exchangeId, { ...input.credentials, apiKey, secret });
  let markets: Record<string, CcxtMarket>;
  let name = exchangeId;
  try {
    markets = await client.loadMarkets();
    await client.fetchBalance(); // Beweis: Keys funktionieren wirklich
    const clientName = (client as { name?: string }).name;
    if (typeof clientName === 'string' && clientName.length > 0) name = clientName;
  } catch (err) {
    throw new Error(`Verbindung zu ${exchangeId} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = summarizeMarkets(markets);

  const [row] = await db
    .insert(exchangeConnections)
    .values({
      userId: input.userId,
      exchangeId,
      exchangeName: name,
      label: input.label?.trim() || null,
      encryptedPayload: encryptCredentials({ apiKey, secret, ...(input.credentials.password ? { password: input.credentials.password } : {}), ...(input.credentials.uid ? { uid: input.credentials.uid } : {}) }),
      keyLast4: apiKey.slice(-4),
      mode: input.mode,
      status: 'active',
      lastValidatedAt: new Date(),
      marketsSummary: summary,
      maxLeverage: summary.maxLeverage === null ? null : String(summary.maxLeverage),
    })
    .returning();
  return toDto(row!);
}

export type ConnectWalletInput = {
  userId: string;
  exchangeId: string;
  walletAddress: string;
  label?: string;
};

/**
 * Wallet anschließen (nur lesend): die öffentliche Adresse wird SOFORT gegen
 * die echte Börse geprüft (loadMarkets + fetchBalance für genau diese Adresse).
 * Es wird nie ein Private Key angenommen oder gespeichert — eine Wallet-
 * Verbindung kann daher technisch keine Orders und keine Transfers auslösen.
 */
export async function connectWallet(
  db: Db,
  input: ConnectWalletInput,
  createClient: CreateClient = defaultCreateClient,
): Promise<ConnectionDto> {
  const exchangeId = input.exchangeId.trim().toLowerCase();
  if (!walletExchanges().some((e) => e.id === exchangeId)) {
    throw new Error(`"${exchangeId}" unterstützt keinen Wallet-Anschluss — bitte API-Keys verwenden.`);
  }
  if (!isValidEvmAddress(input.walletAddress)) {
    throw new Error('Ungültige Wallet-Adresse — erwartet 0x gefolgt von 40 Hex-Zeichen.');
  }
  const walletAddress = input.walletAddress.trim().toLowerCase();
  const client = createClient(exchangeId, { walletAddress });
  let markets: Record<string, CcxtMarket>;
  let name = exchangeId;
  try {
    markets = await client.loadMarkets();
    await client.fetchBalance(); // Beweis: die Adresse hat dort wirklich ein Konto
    const clientName = (client as { name?: string }).name;
    if (typeof clientName === 'string' && clientName.length > 0) name = clientName;
  } catch (err) {
    throw new Error(`Wallet-Prüfung bei ${exchangeId} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = summarizeMarkets(markets);
  const [row] = await db
    .insert(exchangeConnections)
    .values({
      userId: input.userId,
      exchangeId,
      exchangeName: name,
      label: input.label?.trim() || null,
      encryptedPayload: encryptCredentials({ walletAddress }),
      keyLast4: maskAddress(walletAddress),
      mode: 'read_only',
      status: 'active',
      lastValidatedAt: new Date(),
      marketsSummary: summary,
      maxLeverage: summary.maxLeverage === null ? null : String(summary.maxLeverage),
    })
    .returning();
  return toDto(row!);
}

export async function listConnections(db: Db, userId: string): Promise<ConnectionDto[]> {
  const rows = await db
    .select()
    .from(exchangeConnections)
    .where(eq(exchangeConnections.userId, userId));
  return rows
    .filter((r) => r.status !== 'revoked')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(toDto);
}

async function loadOwnConnection(db: Db, userId: string, connectionId: string) {
  const [row] = await db
    .select()
    .from(exchangeConnections)
    .where(and(eq(exchangeConnections.id, connectionId), eq(exchangeConnections.userId, userId)))
    .limit(1);
  if (!row) throw new Error('Verbindung nicht gefunden.');
  if (row.status === 'revoked') throw new Error('Verbindung wurde getrennt.');
  return row;
}

export type ConnectionBalance = { currency: string; total: number; free: number; used: number };

/** Echte Kontostände der Börse (read_only reicht). Aktualisiert last_validated_at ehrlich. */
export async function fetchConnectionBalances(
  db: Db,
  userId: string,
  connectionId: string,
  createClient: CreateClient = defaultCreateClient,
): Promise<ConnectionBalance[]> {
  const row = await loadOwnConnection(db, userId, connectionId);
  const creds = decryptCredentials(row.encryptedPayload) as unknown as StoredCredentials;
  const client = createClient(row.exchangeId, creds);
  try {
    const balance = await client.fetchBalance();
    const total = balance.total ?? {};
    const free = balance.free ?? {};
    const used = balance.used ?? {};
    const out: ConnectionBalance[] = Object.entries(total)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([currency, v]) => ({
        currency,
        total: v,
        free: typeof free[currency] === 'number' ? free[currency] : 0,
        used: typeof used[currency] === 'number' ? used[currency] : 0,
      }))
      .sort((a, b) => b.total - a.total);
    await db
      .update(exchangeConnections)
      .set({ status: 'active', lastError: null, lastValidatedAt: new Date(), updatedAt: new Date() })
      .where(eq(exchangeConnections.id, row.id));
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(exchangeConnections)
      .set({ status: 'error', lastError: message, updatedAt: new Date() })
      .where(eq(exchangeConnections.id, row.id));
    throw new Error(`Kontostand von ${row.exchangeName} konnte nicht geladen werden: ${message}`);
  }
}

/** Markt-Erkennung neu laden (z. B. wenn die Börse neue Assets listet). */
export async function refreshConnectionMarkets(
  db: Db,
  userId: string,
  connectionId: string,
  createClient: CreateClient = defaultCreateClient,
): Promise<MarketsSummary> {
  const row = await loadOwnConnection(db, userId, connectionId);
  const creds = decryptCredentials(row.encryptedPayload) as unknown as StoredCredentials;
  const client = createClient(row.exchangeId, creds);
  const summary = summarizeMarkets(await client.loadMarkets());
  await db
    .update(exchangeConnections)
    .set({
      marketsSummary: summary,
      maxLeverage: summary.maxLeverage === null ? null : String(summary.maxLeverage),
      updatedAt: new Date(),
    })
    .where(eq(exchangeConnections.id, row.id));
  return summary;
}

export async function setConnectionMode(
  db: Db,
  userId: string,
  connectionId: string,
  mode: 'read_only' | 'trading',
): Promise<ConnectionDto> {
  const row = await loadOwnConnection(db, userId, connectionId);
  if (mode === 'trading' && isWalletRow(row)) {
    throw new Error('Wallet-Verbindungen sind nur lesend — ohne Signatur-Schlüssel sind keine Orders möglich.');
  }
  const [updated] = await db
    .update(exchangeConnections)
    .set({ mode, updatedAt: new Date() })
    .where(eq(exchangeConnections.id, row.id))
    .returning();
  return toDto(updated!);
}

/** Trennen = widerrufen (Audit bleibt erhalten), Payload wird überschrieben — Keys sind danach weg. */
export async function revokeConnection(db: Db, userId: string, connectionId: string): Promise<void> {
  const row = await loadOwnConnection(db, userId, connectionId);
  await db
    .update(exchangeConnections)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date(), encryptedPayload: 'revoked' })
    .where(eq(exchangeConnections.id, row.id));
}

/** Router-Sicht auf die Verbindungen eines Users (für pickConnectionForSymbol). */
export async function loadRoutingConnections(db: Db, userId: string): Promise<ConnectionForRouting[]> {
  const rows = await db.select().from(exchangeConnections).where(eq(exchangeConnections.userId, userId));
  return rows.map((r) => ({
    id: r.id,
    exchangeId: r.exchangeId,
    mode: r.mode,
    status: r.status,
    createdAt: r.createdAt,
    marketsSummary: (r.marketsSummary as MarketsSummary | null) ?? null,
  }));
}
