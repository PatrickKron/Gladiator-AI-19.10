import { describe, expect, it } from 'vitest';
import { assetProfile } from '@gladiator/core';
import { buildAssetEventView, type CalendarRow } from './asset-events.js';

const now = new Date('2026-10-25T12:00:00Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);
const row = (title: string, currency: string | null, importance: number | null, min: number): CalendarRow => ({ title, currency, importance, scheduledAt: at(min) });

const events: CalendarRow[] = [
  row('BOJ Policy Rate', 'JPY', 3, 10), // Fenster aktiv (in 10 min), betrifft BTC NICHT
  row('CPI m/m', 'USD', 3, 180),
  row('German Ifo Business Climate', 'EUR', 3, 240),
  row('Retail Sales m/m', 'USD', 2, 300), // kein High-Impact
  row('Non-Farm Employment Change', 'USD', 3, 2 * 24 * 60),
  row('Old CPI', 'USD', 3, -120), // vorbei
];

describe('buildAssetEventView', () => {
  it('BTC: nur relevante High-Impact-Termine (USD), aufsteigend, keine vergangenen', () => {
    const v = buildAssetEventView(events, now, assetProfile('BTC/USDT', 'binance'), null);
    expect(v.filter).toBe('asset');
    expect(v.currencies).toEqual(['USD']);
    expect(v.upcoming.map((e) => e.title)).toEqual(['CPI m/m', 'Non-Farm Employment Change']);
    expect(v.nextHigh?.title).toBe('CPI m/m');
    expect(v.upcoming[0]!.category).toBe('cpi');
  });

  it('Engine-Fenster aktiv durch einen Termin, der BTC nicht betrifft → scope global (nie „frei")', () => {
    const engine = { active: true as const, reason: 'BOJ Policy Rate (JPY) um 12:10 UTC', event: { title: 'BOJ Policy Rate', currency: 'JPY', importance: 3, scheduledAt: at(10) } };
    const v = buildAssetEventView(events, now, assetProfile('BTC/USDT', 'binance'), engine);
    expect(v.engine).toEqual({ active: true, reason: 'BOJ Policy Rate (JPY) um 12:10 UTC', scope: 'global' });
  });

  it('dasselbe Fenster betrifft USD/JPY → scope asset; JPY-Termin steht in der Liste', () => {
    const engine = { active: true as const, reason: 'BOJ', event: { title: 'BOJ Policy Rate', currency: 'JPY', importance: 3, scheduledAt: at(10) } };
    const v = buildAssetEventView(events, now, assetProfile('USDJPY=X', 'yahoo'), engine);
    expect(v.engine.scope).toBe('asset');
    expect(v.upcoming.map((e) => e.title)).toEqual(['BOJ Policy Rate', 'CPI m/m', 'Non-Farm Employment Change']);
  });

  it('SAP.DE: EUR-Termine zählen, USD nur mit globaler Reichweite', () => {
    const v = buildAssetEventView(events, now, assetProfile('SAP.DE', 'yahoo'), null);
    expect(v.upcoming.map((e) => e.title)).toEqual(['German Ifo Business Climate']);
  });

  it('Asset unbekannt → alle High-Impact-Termine, filter all', () => {
    const v = buildAssetEventView(events, now, null, null);
    expect(v.filter).toBe('all');
    expect(v.currencies).toBeNull();
    expect(v.upcoming).toHaveLength(4);
  });

  it('kein Fenster → scope none, reason null', () => {
    expect(buildAssetEventView([], now, assetProfile('BTC/USDT', 'binance'), null).engine).toEqual({ active: false, reason: null, scope: 'none' });
  });

  it('Liste gekappt', () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`CPI ${i}`, 'USD', 3, 60 + i));
    expect(buildAssetEventView(many, now, assetProfile('BTC/USDT', 'binance'), null, 5).upcoming).toHaveLength(5);
  });
});
