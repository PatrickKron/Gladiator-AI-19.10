import { describe, expect, it } from 'vitest';
import {
  CPI_PHASE_DEFAULTS,
  cpiInflationYoY,
  cpiScore,
  deriveCpiPhase,
  deriveCpiSurprise,
  isCpiEvent,
  type CpiEventLike,
} from './cpi.js';

const now = new Date('2026-07-10T12:00:00Z');
function cpiAt(offsetHours: number, extra: Partial<CpiEventLike> = {}): CpiEventLike {
  return {
    title: 'CPI m/m',
    currency: 'USD',
    importance: 3,
    scheduledAt: new Date(now.getTime() + offsetHours * 3_600_000),
    actual: null,
    forecast: null,
    ...extra,
  };
}

describe('isCpiEvent', () => {
  it('erkennt CPI-Events am Titel', () => {
    expect(isCpiEvent({ title: 'Core CPI m/m' })).toBe(true);
    expect(isCpiEvent({ title: 'Consumer Price Index y/y' })).toBe(true);
    expect(isCpiEvent({ title: 'Non-Farm Payrolls' })).toBe(false);
    expect(isCpiEvent({ title: 'FOMC Statement' })).toBe(false);
  });
});

describe('deriveCpiPhase', () => {
  it('none, wenn kein CPI-Event in Reichweite', () => {
    expect(deriveCpiPhase([{ ...cpiAt(2), title: 'NFP' }], now).phase).toBe('none');
    expect(deriveCpiPhase([], now).phase).toBe('none');
  });

  it('pre_event innerhalb des Vorlauf-Fensters', () => {
    expect(deriveCpiPhase([cpiAt(6)], now).phase).toBe('pre_event');
    expect(deriveCpiPhase([cpiAt(CPI_PHASE_DEFAULTS.preHours - 1)], now).phase).toBe('pre_event');
  });

  it('none, wenn CPI noch weiter als der Vorlauf entfernt ist', () => {
    expect(deriveCpiPhase([cpiAt(CPI_PHASE_DEFAULTS.preHours + 5)], now).phase).toBe('none');
  });

  it('release_window um den Release herum (±30 min)', () => {
    expect(deriveCpiPhase([cpiAt(0)], now).phase).toBe('release_window');
    expect(deriveCpiPhase([cpiAt(0.4)], now).phase).toBe('release_window');
    expect(deriveCpiPhase([cpiAt(-0.4)], now).phase).toBe('release_window');
  });

  it('post_event kurz nach dem Release', () => {
    expect(deriveCpiPhase([cpiAt(-2)], now).phase).toBe('post_event');
  });

  it('confirmed_reaction nach dem post-Fenster, aber am selben Tag', () => {
    expect(deriveCpiPhase([cpiAt(-8)], now).phase).toBe('confirmed_reaction');
  });

  it('none, wenn das Event zu alt ist', () => {
    expect(deriveCpiPhase([cpiAt(-48)], now).phase).toBe('none');
  });
});

describe('deriveCpiSurprise', () => {
  it('null ohne actual/forecast', () => {
    expect(deriveCpiSurprise(cpiAt(-2))).toBeNull();
    expect(deriveCpiSurprise(null)).toBeNull();
  });
  it('higher, wenn actual über forecast', () => {
    expect(deriveCpiSurprise(cpiAt(-2, { actual: 3.4, forecast: 3.1 }))).toBe('higher');
  });
  it('lower, wenn actual unter forecast', () => {
    expect(deriveCpiSurprise(cpiAt(-2, { actual: 2.8, forecast: 3.1 }))).toBe('lower');
  });
  it('inline bei kleiner Abweichung', () => {
    expect(deriveCpiSurprise(cpiAt(-2, { actual: 3.11, forecast: 3.1 }))).toBe('inline');
  });
});

describe('cpiScore', () => {
  it('neutral-positiv, wenn kein CPI in Reichweite', () => {
    expect(cpiScore('none', null, 'long')).toBeGreaterThan(0.5);
  });
  it('dämpft im Release-Fenster stark', () => {
    expect(cpiScore('release_window', null, 'long')).toBeLessThan(0.2);
  });
  it('richtungsabhängig nach dem Event: kühler CPI begünstigt long', () => {
    const longLower = cpiScore('confirmed_reaction', 'lower', 'long');
    const shortLower = cpiScore('confirmed_reaction', 'lower', 'short');
    expect(longLower).toBeGreaterThan(shortLower);
  });
  it('heißer CPI begünstigt short', () => {
    const shortHigher = cpiScore('confirmed_reaction', 'higher', 'short');
    const longHigher = cpiScore('confirmed_reaction', 'higher', 'long');
    expect(shortHigher).toBeGreaterThan(longHigher);
  });
  it('bleibt in [0,1]', () => {
    for (const p of ['none', 'pre_event', 'release_window', 'post_event', 'confirmed_reaction'] as const) {
      for (const s of ['higher', 'lower', 'inline', null] as const) {
        const v = cpiScore(p, s, 'long');
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('cpiInflationYoY', () => {
  it('null bei zu wenig Punkten', () => {
    expect(cpiInflationYoY([{ ts: new Date('2026-01-01'), value: 300 }])).toBeNull();
  });
  it('berechnet YoY über ~12 Monate', () => {
    const points: { ts: Date; value: number }[] = [];
    for (let m = 0; m < 14; m++) {
      // Start 300, +0.25 % je Monat → ~3 % YoY
      points.push({ ts: new Date(Date.UTC(2025, m, 1)), value: 300 * 1.0025 ** m });
    }
    const yoy = cpiInflationYoY(points);
    expect(yoy).not.toBeNull();
    expect(yoy!).toBeGreaterThan(2.5);
    expect(yoy!).toBeLessThan(3.5);
  });
});
