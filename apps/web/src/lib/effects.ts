/**
 * Special-Effekte (Design-System v3, Patrick 2026-10-21: „den Matrix-Regen
 * als Special-Effekt einführen"). Der Daten-Regen besteht weiter aus ECHTEN
 * Ticks, läuft aber nicht mehr dauernd hinter dem Inhalt, sondern an vier
 * Stellen mit Absicht:
 *
 *  1. Login — Signatur-Moment vor der Anmeldung (Standard an).
 *  2. Ereignis-Impuls — ein kurzer Regenstoß hinter der Oberfläche, wenn etwas
 *     Echtes passiert: neues Signal (blau), Preis-Alarm (blau), Notfall oder
 *     Kill-Switch (rot). Standard an.
 *  3. Bildschirmschoner — nach einigen Minuten ohne Eingabe übernimmt der
 *     Regen den Bildschirm (Uhrzeit, Favoriten-Kurse); jede Eingabe holt die
 *     Oberfläche zurück. Standard an.
 *  4. Matrix-Modus — der Dauer-Regen hinter dem Inhalt wie in v2. Standard AN
 *     (Patrick 2026-10-23: zurück zur v2-Optik); abschaltbar unter Profil → Effekte
 *     oder Tastenkürzel „g m".
 *
 * Reine Logik (Vorlieben, Impuls-Bus) ist hier; das Zeichnen macht
 * components/MatrixRain.tsx, die Entscheidung components/RainLayer.tsx.
 */

export type EffectPrefs = {
  loginRain: boolean;
  eventRain: boolean;
  screensaver: boolean;
  ambientRain: boolean;
};

export const DEFAULT_EFFECTS: EffectPrefs = { loginRain: true, eventRain: true, screensaver: true, ambientRain: true };

export const EFFECTS_KEY = 'gladiator.effects';
const EVENT_PREFS = 'gladiator:effects';
const EVENT_BURST = 'gladiator:rain-burst';

/** Ruhezeit bis zum Bildschirmschoner. */
export const SCREENSAVER_AFTER_MS = 3 * 60_000;

export type RainTone = 'accent' | 'pos' | 'neg';
export type RainBurst = { tone: RainTone; symbol: string | null; until: number };

/** Ereignis-Impuls dauert so lange (Anstieg + Abklingen). */
export const BURST_MS = 2_800;

/** Rohwert aus dem Speicher → vollständige, gültige Vorlieben (Unbekanntes → Standard). */
export function parseEffectPrefs(raw: string | null | undefined): EffectPrefs {
  if (!raw) return { ...DEFAULT_EFFECTS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_EFFECTS };
    const p = parsed as Record<string, unknown>;
    const pick = (k: keyof EffectPrefs) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : DEFAULT_EFFECTS[k]);
    return { loginRain: pick('loginRain'), eventRain: pick('eventRain'), screensaver: pick('screensaver'), ambientRain: pick('ambientRain') };
  } catch {
    return { ...DEFAULT_EFFECTS };
  }
}

/**
 * Welche Benachrichtigung löst welchen Impuls aus? Nur echte Ereignisse mit
 * Handlungsbezug; Briefings und Systemhinweise bleiben still.
 */
export function burstToneFor(kind: string): RainTone | null {
  switch (kind) {
    case 'signal':
    case 'price_alert':
    case 'screen':
      return 'accent';
    case 'emergency':
    case 'kill_switch':
      return 'neg';
    default:
      return null;
  }
}

/**
 * Sichtbarkeit des Regens (0 … 1) aus Zustand und Vorlieben — eine Funktion,
 * damit die Reihenfolge der Regeln testbar bleibt:
 * Bildschirmschoner > Login > Impuls > Matrix-Modus > aus.
 */
export function rainIntensity(input: {
  prefs: EffectPrefs;
  authenticated: boolean;
  idle: boolean;
  burst: RainBurst | null;
  now: number;
}): { intensity: number; tone: RainTone | null; symbol: string | null } {
  const { prefs, authenticated, idle, burst, now } = input;
  if (authenticated && idle && prefs.screensaver) return { intensity: 0.9, tone: null, symbol: null };
  if (!authenticated) return prefs.loginRain ? { intensity: 0.25, tone: null, symbol: null } : { intensity: 0, tone: null, symbol: null };
  const base = prefs.ambientRain ? 0.18 : 0;
  if (burst && prefs.eventRain && burst.until > now) {
    // Anstieg in den ersten 20 %, dann weiches Abklingen auf den Grundwert
    const left = (burst.until - now) / BURST_MS;
    const shape = left > 0.8 ? (1 - left) / 0.2 : left / 0.8;
    return { intensity: Math.max(base, 0.55 * shape), tone: burst.tone, symbol: burst.symbol };
  }
  return { intensity: base, tone: null, symbol: null };
}

// ---- Browser-Seite (Speicher + Ereignis-Bus) -------------------------------

export function getEffectPrefs(): EffectPrefs {
  try {
    return parseEffectPrefs(window.localStorage.getItem(EFFECTS_KEY));
  } catch {
    return { ...DEFAULT_EFFECTS };
  }
}

export function setEffectPrefs(next: Partial<EffectPrefs>): EffectPrefs {
  const merged = { ...getEffectPrefs(), ...next };
  try {
    window.localStorage.setItem(EFFECTS_KEY, JSON.stringify(merged));
  } catch {
    // ohne localStorage gilt die Wahl nur für diese Seite
  }
  window.dispatchEvent(new CustomEvent(EVENT_PREFS));
  return merged;
}

export function onEffectPrefs(fn: (p: EffectPrefs) => void): () => void {
  const handler = () => fn(getEffectPrefs());
  const onStorage = (e: StorageEvent) => {
    if (e.key === EFFECTS_KEY) handler();
  };
  window.addEventListener(EVENT_PREFS, handler);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT_PREFS, handler);
    window.removeEventListener('storage', onStorage);
  };
}

/** Einen Regen-Impuls auslösen (z. B. neues Signal). Mehrere Impulse verlängern den laufenden. */
export function requestRainBurst(tone: RainTone, symbol: string | null = null): void {
  const burst: RainBurst = { tone, symbol, until: performance.now() + BURST_MS };
  window.dispatchEvent(new CustomEvent<RainBurst>(EVENT_BURST, { detail: burst }));
}

export function onRainBurst(fn: (b: RainBurst) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<RainBurst>).detail);
  window.addEventListener(EVENT_BURST, handler);
  return () => window.removeEventListener(EVENT_BURST, handler);
}
