import { describe, expect, it } from 'vitest';
import { hasOnChainArrivalOccurred } from './spot-workflow-watch.js';

describe('hasOnChainArrivalOccurred (Spot-Workflow On-Chain-Wächter)', () => {
  it('erkennt einen echten Anstieg über den Ausgangsbestand beim Kauf', () => {
    expect(hasOnChainArrivalOccurred(0.5, 0.75, true)).toBe(true);
    expect(hasOnChainArrivalOccurred(0, 0.01, true)).toBe(true);
    expect(hasOnChainArrivalOccurred(null, 1.2, true)).toBe(true);
  });

  it('meldet keinen Eingang bei unverändertem Bestand, 0-Bestand ohne Baseline oder nicht unterstütztem RPC', () => {
    expect(hasOnChainArrivalOccurred(0.5, 0.5, true)).toBe(false);
    expect(hasOnChainArrivalOccurred(0.5, 0.4, true)).toBe(false);
    expect(hasOnChainArrivalOccurred(null, 0, true)).toBe(false);
    expect(hasOnChainArrivalOccurred(0, null, true)).toBe(false);
    expect(hasOnChainArrivalOccurred(0, 1.0, false)).toBe(false);
  });
});
