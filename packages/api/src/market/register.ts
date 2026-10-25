import { TRPCError } from '@trpc/server';
import type { Db } from '@gladiator/db';
import { AssetRegisterError, registerAsset, type RegisterDeps, type RegisterInput, type RegisterResult } from '@gladiator/jobs';

/**
 * Asset-Register an der API (product.addAsset, market.ensureCandles, market.ensureStockCandles):
 * EIN Dienst (@gladiator/jobs registerAsset), fachliche Fehler als tRPC-Codes —
 * unbekanntes Symbol = BAD_REQUEST, Quelle nicht erreichbar = PRECONDITION_FAILED,
 * keine einzige Kerze = BAD_GATEWAY. Nie eine leere Register-Zeile.
 */

const CODE = {
  BAD_INPUT: 'BAD_REQUEST',
  UNKNOWN_SYMBOL: 'BAD_REQUEST',
  UNREACHABLE: 'PRECONDITION_FAILED',
  NO_CANDLES: 'BAD_GATEWAY',
} as const;

/** Tests ersetzen die Netz-Quellen (Binance-Paarliste, Yahoo-Suche, Kerzen-Ingest); Produktion: null. */
let depsOverride: RegisterDeps | null = null;
export function setRegisterDepsForTests(deps: RegisterDeps | null): void {
  depsOverride = deps;
}

export function registerErrorToTrpc(err: unknown): unknown {
  return err instanceof AssetRegisterError ? new TRPCError({ code: CODE[err.code], message: err.message }) : err;
}

export async function registerOrThrow(db: Db, input: RegisterInput): Promise<RegisterResult> {
  try {
    return await registerAsset(db, input, depsOverride ?? {});
  } catch (err) {
    throw registerErrorToTrpc(err);
  }
}
