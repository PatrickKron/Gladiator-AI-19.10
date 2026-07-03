import { initTRPC, TRPCError } from '@trpc/server';
import type { Db } from '@gladiator/db';
import type { LivePriceFeed } from '@gladiator/market-data';
import type { TradingVenue } from '@gladiator/exchange';
import { verifyAccessToken } from './auth/tokens.js';
import { getUserById, type PublicUser } from './auth/service.js';

export type Context = {
  db: Db;
  /** Aus verifiziertem JWT geladen — NIE aus Client-Input. null = nicht angemeldet. */
  user: PublicUser | null;
  /** Live-Preis-Feed; null = Feed nicht gestartet → UI zeigt ehrlich "nicht verbunden". */
  prices: LivePriceFeed | null;
  /** Aktiver Trading-Venue (Paper-Default); null = kein Venue → Ausführung unmöglich. */
  venue: TradingVenue | null;
  userAgent: string | null;
  ip: string | null;
};

/** Context aus dem Authorization-Header bauen. Ungültiges/fehlendes Token → user: null. */
export async function buildContext(opts: {
  db: Db;
  prices?: LivePriceFeed | null;
  venue?: TradingVenue | null;
  authorizationHeader?: string | null;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<Context> {
  let user: PublicUser | null = null;
  const header = opts.authorizationHeader;
  if (header?.startsWith('Bearer ')) {
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    if (payload) {
      user = await getUserById(opts.db, payload.userId);
    }
  }
  return {
    db: opts.db,
    user,
    prices: opts.prices ?? null,
    venue: opts.venue ?? null,
    userAgent: opts.userAgent ?? null,
    ip: opts.ip ?? null,
  };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/** Erzwingt gültige Auth: ohne verifizierten User → UNAUTHORIZED (401). Kein Fallback. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Anmeldung erforderlich.' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
