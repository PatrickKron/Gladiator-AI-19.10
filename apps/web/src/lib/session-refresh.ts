/**
 * Multi-Tab-sicherer Session-Refresh (Befund Browser-Verifikation 2026-07-03).
 *
 * Problem: Refresh-Tokens rotieren bei jeder Nutzung, Reuse widerruft ALLE
 * Sessions (Sicherheitsdesign Phase 0b). Mit mehreren offenen Tabs entsteht
 * ein Wettrennen — der Verlierer nutzt den verbrauchten Token und loggt den
 * User zufällig aus. Lösung: browserweiter Lock + Konflikt-Auflösung durch
 * Neulesen des Storage (ein anderer Tab kann inzwischen rotiert haben).
 */

export type RefreshOutcome =
  | 'ok' // rotiert, neue Session gespeichert
  | 'retry-later' // transienter Fehler (Netz/Server) — Session behalten
  | 'dead'; // Token unbrauchbar — Session entsorgt, Login nötig

export type RefreshDeps = {
  /** Aktuellen Refresh-Token lesen (localStorage — von allen Tabs geteilt). */
  readStored: () => string | null;
  /** Neue Session persistieren; null = Session entsorgen. */
  writeSession: (tokens: { accessToken: string; refreshToken: string } | null) => void;
  /** auth.refresh-Mutation gegen den Server. */
  mutate: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string }>;
  /** true, wenn der Fehler ein Auth-Fehler ist (sonst Netz/Server → behalten). */
  isAuthError: (err: unknown) => boolean;
  /** Cross-Tab-Lock (navigator.locks); Fallback: direkter Aufruf. */
  lock: <T>(fn: () => Promise<T>) => Promise<T>;
};

export async function refreshWithConflictResolution(deps: RefreshDeps): Promise<RefreshOutcome> {
  return deps.lock(async () => {
    const token = deps.readStored();
    if (!token) return 'dead';
    try {
      deps.writeSession(await deps.mutate(token));
      return 'ok';
    } catch (err) {
      if (!deps.isAuthError(err)) return 'retry-later';
      // Auth-Fehler: eventuell hat ein anderer Tab GENAU JETZT rotiert —
      // dann liegt im Storage bereits sein Nachfolge-Token.
      const current = deps.readStored();
      if (current && current !== token) {
        try {
          deps.writeSession(await deps.mutate(current));
          return 'ok';
        } catch (retryErr) {
          if (!deps.isAuthError(retryErr)) return 'retry-later';
        }
      }
      deps.writeSession(null);
      return 'dead';
    }
  });
}

/** navigator.locks, wenn verfügbar (Browser); sonst Durchreiche (Tests/ältere Engines). */
export function webLock(name: string): <T>(fn: () => Promise<T>) => Promise<T> {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (locks) return (await locks.request(name, fn)) as T;
    return fn();
  };
}
