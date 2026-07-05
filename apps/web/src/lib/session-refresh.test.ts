import { describe, expect, it } from 'vitest';
import { refreshWithConflictResolution, type RefreshDeps, type RefreshOutcome } from './session-refresh.js';

/**
 * Multi-Tab-Refresh (Bug aus der Browser-Verifikation 2026-07-03):
 * Zwei Tabs rotieren denselben Refresh-Token → der Verlierer benutzt einen
 * verbrauchten Token → Reuse-Detection widerruft ALLE Sessions → Zufalls-Logout.
 * Fix: Cross-Tab-Lock + Konflikt-Auflösung über localStorage-Neulesen.
 * Netzwerkfehler dürfen NIE ausloggen (Session behalten, später erneut).
 */

type Tokens = { accessToken: string; refreshToken: string };

function makeDeps(overrides: Partial<RefreshDeps> = {}) {
  const writes: (Tokens | null)[] = [];
  const deps: RefreshDeps = {
    readStored: () => 'R1',
    writeSession: (t) => void writes.push(t),
    mutate: (token) => Promise.resolve({ accessToken: `A(${token})`, refreshToken: `next(${token})` }),
    isAuthError: () => true,
    lock: (fn) => fn(),
    ...overrides,
  };
  return { deps, writes };
}

describe('refreshWithConflictResolution', () => {
  it('happy path: rotiert und speichert die neue Session', async () => {
    const { deps, writes } = makeDeps();
    const out = await refreshWithConflictResolution(deps);
    expect(out).toBe<RefreshOutcome>('ok');
    expect(writes).toEqual([{ accessToken: 'A(R1)', refreshToken: 'next(R1)' }]);
  });

  it('ohne gespeicherten Token: dead, kein mutate-Aufruf', async () => {
    let called = 0;
    const { deps, writes } = makeDeps({
      readStored: () => null,
      mutate: () => {
        called++;
        return Promise.reject(new Error('darf nicht aufgerufen werden'));
      },
    });
    expect(await refreshWithConflictResolution(deps)).toBe<RefreshOutcome>('dead');
    expect(called).toBe(0);
    expect(writes).toEqual([]);
  });

  it('Auth-Fehler ohne Konkurrenz-Rotation: Session wird entsorgt (dead)', async () => {
    const { deps, writes } = makeDeps({ mutate: () => Promise.reject(new Error('UNAUTHORIZED')) });
    expect(await refreshWithConflictResolution(deps)).toBe<RefreshOutcome>('dead');
    expect(writes).toEqual([null]);
  });

  it('Auth-Fehler, aber anderer Tab hat rotiert: mit dessen Token erneut, Erfolg', async () => {
    const stored = ['R1', 'R2']; // beim Neulesen liegt R2 (vom anderen Tab)
    const attempts: string[] = [];
    const { deps, writes } = makeDeps({
      readStored: () => stored.shift() ?? 'R2',
      mutate: (token) => {
        attempts.push(token);
        if (token === 'R1') return Promise.reject(new Error('UNAUTHORIZED (reuse)'));
        return Promise.resolve({ accessToken: 'A2', refreshToken: 'R3' });
      },
    });
    expect(await refreshWithConflictResolution(deps)).toBe<RefreshOutcome>('ok');
    expect(attempts).toEqual(['R1', 'R2']);
    expect(writes).toEqual([{ accessToken: 'A2', refreshToken: 'R3' }]);
  });

  it('Auth-Fehler, Konkurrenz-Token schlägt ebenfalls fehl: dead', async () => {
    const stored = ['R1', 'R2'];
    const { deps, writes } = makeDeps({
      readStored: () => stored.shift() ?? 'R2',
      mutate: () => Promise.reject(new Error('UNAUTHORIZED')),
    });
    expect(await refreshWithConflictResolution(deps)).toBe<RefreshOutcome>('dead');
    expect(writes).toEqual([null]);
  });

  it('Netzwerkfehler: Session BEHALTEN (retry-later), niemals ausloggen', async () => {
    const { deps, writes } = makeDeps({
      mutate: () => Promise.reject(new Error('fetch failed')),
      isAuthError: () => false,
    });
    expect(await refreshWithConflictResolution(deps)).toBe<RefreshOutcome>('retry-later');
    expect(writes).toEqual([]);
  });

  it('läuft vollständig innerhalb des Cross-Tab-Locks', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      lock: async (fn) => {
        order.push('lock-start');
        const r = await fn();
        order.push('lock-end');
        return r;
      },
      mutate: (token) => {
        order.push(`mutate(${token})`);
        return Promise.resolve({ accessToken: 'A', refreshToken: 'R2' });
      },
    });
    await refreshWithConflictResolution(deps);
    expect(order).toEqual(['lock-start', 'mutate(R1)', 'lock-end']);
  });
});
