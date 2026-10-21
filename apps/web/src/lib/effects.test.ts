import { describe, expect, it } from 'vitest';
import { BURST_MS, DEFAULT_EFFECTS, burstToneFor, parseEffectPrefs, rainIntensity } from './effects.js';

describe('Special-Effekte: Vorlieben und Regen-Regeln', () => {
  it('parseEffectPrefs: fehlend/kaputt → Standard, Teilwerte werden ergänzt', () => {
    expect(parseEffectPrefs(null)).toEqual(DEFAULT_EFFECTS);
    expect(parseEffectPrefs('kein json')).toEqual(DEFAULT_EFFECTS);
    expect(parseEffectPrefs('[1,2]')).toEqual(DEFAULT_EFFECTS);
    expect(parseEffectPrefs('{"ambientRain":true,"screensaver":"ja"}')).toEqual({ ...DEFAULT_EFFECTS, ambientRain: true });
    expect(DEFAULT_EFFECTS.ambientRain).toBe(false); // der Dauer-Regen ist eine bewusste Wahl
  });

  it('nur Ereignisse mit Handlungsbezug lösen einen Impuls aus', () => {
    expect(burstToneFor('signal')).toBe('accent');
    expect(burstToneFor('price_alert')).toBe('accent');
    expect(burstToneFor('kill_switch')).toBe('neg');
    expect(burstToneFor('emergency')).toBe('neg');
    expect(burstToneFor('briefing')).toBeNull();
    expect(burstToneFor('system')).toBeNull();
  });

  it('Reihenfolge: Bildschirmschoner > Login > Impuls > Matrix-Modus > aus', () => {
    const prefs = { ...DEFAULT_EFFECTS };
    expect(rainIntensity({ prefs, authenticated: true, idle: false, burst: null, now: 0 }).intensity).toBe(0);
    expect(rainIntensity({ prefs, authenticated: false, idle: false, burst: null, now: 0 }).intensity).toBe(0.25);
    expect(rainIntensity({ prefs: { ...prefs, loginRain: false }, authenticated: false, idle: false, burst: null, now: 0 }).intensity).toBe(0);
    expect(rainIntensity({ prefs, authenticated: true, idle: true, burst: null, now: 0 }).intensity).toBe(0.9);
    expect(rainIntensity({ prefs: { ...prefs, screensaver: false }, authenticated: true, idle: true, burst: null, now: 0 }).intensity).toBe(0);
    expect(rainIntensity({ prefs: { ...prefs, ambientRain: true }, authenticated: true, idle: false, burst: null, now: 0 }).intensity).toBe(0.18);
  });

  it('Impuls: steigt an, klingt ab, endet; ohne eventRain kein Impuls', () => {
    const prefs = { ...DEFAULT_EFFECTS };
    const burst = { tone: 'accent' as const, symbol: 'BTC/USDT', until: BURST_MS };
    const early = rainIntensity({ prefs, authenticated: true, idle: false, burst, now: BURST_MS * 0.1 });
    const peak = rainIntensity({ prefs, authenticated: true, idle: false, burst, now: BURST_MS * 0.2 });
    const late = rainIntensity({ prefs, authenticated: true, idle: false, burst, now: BURST_MS * 0.9 });
    expect(peak.intensity).toBeCloseTo(0.55, 5);
    expect(early.intensity).toBeGreaterThan(0);
    expect(early.intensity).toBeLessThan(peak.intensity);
    expect(late.intensity).toBeLessThan(peak.intensity);
    expect(peak.tone).toBe('accent');
    expect(peak.symbol).toBe('BTC/USDT');
    expect(rainIntensity({ prefs, authenticated: true, idle: false, burst, now: BURST_MS + 1 }).intensity).toBe(0);
    expect(rainIntensity({ prefs: { ...prefs, eventRain: false }, authenticated: true, idle: false, burst, now: 10 }).intensity).toBe(0);
    // Matrix-Modus bleibt unter dem Impuls als Grundwert erhalten
    expect(rainIntensity({ prefs: { ...prefs, ambientRain: true }, authenticated: true, idle: false, burst, now: BURST_MS * 0.99 }).intensity).toBe(0.18);
  });
});
