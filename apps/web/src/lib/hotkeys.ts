/**
 * Tastenkürzel (UI-Welle 5), Gmail-/GitHub-Muster: „g“ und dann ein Buchstabe
 * springt zu einer Hauptseite, „?“ zeigt die Hilfe, „/“ öffnet die Suche.
 * Rein & getestet; die Komponente hängt sie nur an `keydown`.
 */

export const GOTO_KEYS: { key: string; hash: string; labelKey: string }[] = [
  { key: 'h', hash: '#/', labelKey: 'ia.page_today' },
  { key: 'c', hash: '#/charts', labelKey: 'ia.page_chart' },
  { key: 's', hash: '#/signals', labelKey: 'ia.page_signals' },
  { key: 't', hash: '#/traden', labelKey: 'ia.page_tradeHub' },
  { key: 'w', hash: '#/traden?tab=wallet', labelKey: 'ia.page_wallet' },
  { key: 'v', hash: '#/vermoegen', labelKey: 'ia.page_wealth' },
  { key: 'a', hash: '#/agenten', labelKey: 'ia.page_agents' },
  { key: 'l', hash: '#/labor', labelKey: 'ia.page_lab' },
  { key: 'e', hash: '#/einstellungen', labelKey: 'ia.page_settings' },
];

/** Zeitfenster für die zweite Taste nach „g“. */
export const SEQUENCE_MS = 1_200;

export type HotkeyAction = { type: 'goto'; hash: string } | { type: 'help' } | { type: 'search' } | { type: 'matrix' } | { type: 'pending' } | null;

/** „g m“: Matrix-Modus (Dauer-Regen hinter dem Inhalt) ein/aus — Special-Effekt, keine Seite. */
export const MATRIX_KEY = 'm';

/**
 * Bewertet eine Taste. `pendingSince` = Zeitpunkt des letzten „g“ (oder null).
 * Ergebnis `pending` heißt: „g“ gemerkt, auf die zweite Taste warten.
 */
export function resolveHotkey(key: string, pendingSince: number | null, now: number): HotkeyAction {
  if (pendingSince !== null && now - pendingSince <= SEQUENCE_MS) {
    const hit = GOTO_KEYS.find((g) => g.key === key.toLowerCase());
    if (hit) return { type: 'goto', hash: hit.hash };
    return key.toLowerCase() === MATRIX_KEY ? { type: 'matrix' } : null;
  }
  if (key === 'g') return { type: 'pending' };
  if (key === '?') return { type: 'help' };
  if (key === '/') return { type: 'search' };
  return null;
}

/** Ansichts-Merker im Browser (keine Daten, keine Anmeldung) — für „Ansicht zurücksetzen“. */
export const VIEW_PREFERENCE_KEYS = [
  'gladiator.uiMode',
  'gladiator.tradeAccount',
  'gladiator.chartBookDock',
  'gladiator.selectedAsset',
  'gladiator.demoMode',
  'gladiator.effects',
  'gladiator.chartToggles',
];
