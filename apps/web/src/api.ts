import { createTRPCClient, httpBatchLink, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable, type Unsubscribable } from '@trpc/server/observable';
import type { AppRouter } from '@gladiator/api';
import { refreshWithConflictResolution, webLock, type RefreshOutcome } from './lib/session-refresh.js';

const REFRESH_KEY = 'gladiator.refreshToken';

let accessToken: string | null = null;
let refreshTimer: number | null = null;
const authListeners = new Set<(authed: boolean) => void>();

/**
 * 401-Retry: Läuft ein Access-Token mitten in der Nutzung ab, wird EINMAL
 * still refresht und der Call wiederholt — statt Server-Fehlertext im UI.
 * auth.*-Calls sind ausgenommen (sonst Rekursion über auth.refresh).
 */
function authRetryLink(): TRPCLink<AppRouter> {
  return () =>
    ({ next, op }) =>
      observable((observer) => {
        let sub: Unsubscribable | null = null;
        let retried = false;
        const attempt = () => {
          sub = next(op).subscribe({
            next: (v) => observer.next(v),
            complete: () => observer.complete(),
            error: (err) => {
              const unauthorized = err instanceof TRPCClientError && err.data?.code === 'UNAUTHORIZED';
              if (unauthorized && !retried && !op.path.startsWith('auth.')) {
                retried = true;
                void refreshSession().then((outcome) => {
                  if (outcome === 'ok') attempt();
                  else observer.error(err);
                });
              } else {
                observer.error(err);
              }
            },
          });
        };
        attempt();
        return () => sub?.unsubscribe();
      });
}

export const trpc = createTRPCClient<AppRouter>({
  links: [
    authRetryLink(),
    httpBatchLink({
      url: '/api/trpc',
      headers: () => (accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    }),
  ],
});

export function getAccessToken(): string | null {
  return accessToken;
}

export function onAuthChange(fn: (authed: boolean) => void): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

function setSession(tokens: { accessToken: string; refreshToken: string } | null) {
  accessToken = tokens?.accessToken ?? null;
  if (tokens) localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  else localStorage.removeItem(REFRESH_KEY);

  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = null;
  if (tokens) {
    // Access-Token hält 15 min → alle 10 min rotieren (multi-tab-sicher via Lock).
    refreshTimer = window.setInterval(() => void refreshSession(), 10 * 60 * 1000);
  }
  for (const fn of authListeners) fn(accessToken !== null);
}

export async function login(email: string, password: string): Promise<void> {
  const res = await trpc.auth.login.mutate({ email, password });
  setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
}

const refreshLock = webLock('gladiator.session-refresh');

export async function refreshSession(): Promise<RefreshOutcome> {
  const outcome = await refreshWithConflictResolution({
    readStored: () => localStorage.getItem(REFRESH_KEY),
    writeSession: setSession,
    mutate: (refreshToken) => trpc.auth.refresh.mutate({ refreshToken }),
    isAuthError: isUnauthorized,
    lock: refreshLock,
  });
  // Bei transienten Fehlern läuft der Timer weiter und versucht es erneut;
  // die bestehende Session (Access-Token bis zu 15 min gültig) bleibt nutzbar.
  return outcome;
}

export async function logout(): Promise<void> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (refreshToken) {
    try {
      await trpc.auth.logout.mutate({ refreshToken });
    } catch {
      // Logout ist idempotent — lokale Session wird in jedem Fall entsorgt.
    }
  }
  setSession(null);
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === 'UNAUTHORIZED';
}
