import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@gladiator/api';

const REFRESH_KEY = 'gladiator.refreshToken';

let accessToken: string | null = null;
let refreshTimer: number | null = null;
const authListeners = new Set<(authed: boolean) => void>();

export const trpc = createTRPCClient<AppRouter>({
  links: [
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
    // Access-Token hält 15 min → alle 10 min rotieren.
    refreshTimer = window.setInterval(() => void refreshSession(), 10 * 60 * 1000);
  }
  for (const fn of authListeners) fn(accessToken !== null);
}

export async function login(email: string, password: string): Promise<void> {
  const res = await trpc.auth.login.mutate({ email, password });
  setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
}

export async function refreshSession(): Promise<boolean> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  try {
    const res = await trpc.auth.refresh.mutate({ refreshToken });
    setSession(res);
    return true;
  } catch {
    setSession(null);
    return false;
  }
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
