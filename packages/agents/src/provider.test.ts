import { describe, expect, it } from 'vitest';
import { AnthropicProvider, CostGuard, guardedComplete, type LlmProvider } from './provider.js';

describe('Provider-Router & Kosten-Wächter (08_ §2)', () => {
  it('AnthropicProvider ohne Key: nicht konfiguriert, Aufruf wirft (kein stiller Fallback)', async () => {
    const p = new AnthropicProvider(undefined);
    expect(p.configured).toBe(false);
    await expect(p.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/nicht konfiguriert/);
  });

  it('AnthropicProvider mit Key: konfiguriert (Aufruf erst im echten Einsatz)', () => {
    const p = new AnthropicProvider('sk-ant-test-nicht-echt');
    expect(p.configured).toBe(true);
    expect(p.id).toBe('anthropic');
  });

  it('CostGuard: Budget wird verbraucht und blockt bei Erschöpfung', () => {
    const g = new CostGuard({ dailyBudgetUsd: 1 });
    const day = new Date('2026-07-03T10:00:00Z');
    expect(g.allow(day)).toBe(true);
    g.record(0.6, day);
    expect(g.allow(day)).toBe(true);
    g.record(0.5, day);
    expect(g.allow(day)).toBe(false);
    expect(g.spentUsd(day)).toBeCloseTo(1.1, 5);
  });

  it('CostGuard: neuer UTC-Tag setzt das Budget zurück', () => {
    const g = new CostGuard({ dailyBudgetUsd: 1 });
    g.record(2, new Date('2026-07-03T23:00:00Z'));
    expect(g.allow(new Date('2026-07-03T23:30:00Z'))).toBe(false);
    expect(g.allow(new Date('2026-07-04T00:30:00Z'))).toBe(true);
  });

  it('guardedComplete: blockt bei erschöpftem Budget mit ehrlicher Meldung und bucht Kosten', async () => {
    const calls: string[] = [];
    const fake: LlmProvider = {
      id: 'fake',
      configured: true,
      complete: async ({ prompt }) => {
        calls.push(prompt);
        return { text: 'ok', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.7 };
      },
    };
    const g = new CostGuard({ dailyBudgetUsd: 1 });
    const day = new Date('2026-07-03T10:00:00Z');

    const r1 = await guardedComplete(fake, g, { system: 's', prompt: 'a' }, day);
    expect(r1.text).toBe('ok');
    expect(g.spentUsd(day)).toBeCloseTo(0.7, 5);

    await guardedComplete(fake, g, { system: 's', prompt: 'b' }, day); // 1.4 > 1 → danach zu
    await expect(guardedComplete(fake, g, { system: 's', prompt: 'c' }, day)).rejects.toThrow(/Tagesbudget/);
    expect(calls).toEqual(['a', 'b']); // dritter Call hat den Provider NIE erreicht
  });
});
