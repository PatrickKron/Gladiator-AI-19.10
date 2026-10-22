/**
 * Einrichtungs-Fortschritt (Welle F): „Dein Start — n von 5". Die Schritte kommen
 * vom Server (setup.progress) aus ECHTEN Zuständen (Audit, Favoriten, Demo-Orders,
 * Push/Telegram, Börsen); hier liegt nur die reine UI-Logik: nächster Schritt,
 * Ziel-Link je Schritt, Ausblenden und der „Moment", wenn ein Schritt neu erledigt ist.
 */

export type SetupStepId = 'risk' | 'watch' | 'paperTrade' | 'notify' | 'exchange';
export type SetupStep = { id: SetupStepId; done: boolean };

/** Wohin der Schritt führt — immer eine bestehende Seite der Registry. */
export const SETUP_STEP_LINKS: Record<SetupStepId, string> = {
  risk: '#/einstellungen?tab=risiko',
  watch: '#/pakete',
  paperTrade: '#/traden?tab=demo',
  notify: '#/einstellungen?tab=keys',
  exchange: '#/echtes-geld',
};

/** Ausgeblendet (Wahl des Nutzers) und zuletzt gesehener Stand — beides nur Ansichts-Merker im Browser. */
export const SETUP_HIDDEN_KEY = 'gladiator.setupHidden';
export const SETUP_LAST_DONE_KEY = 'gladiator.setupDone';

/** Erster offener Schritt in Reihenfolge — null, wenn alles erledigt ist. */
export function nextStep(steps: readonly SetupStep[]): SetupStepId | null {
  return steps.find((s) => !s.done)?.id ?? null;
}

/**
 * Erfolgsmoment: nur wenn ein früherer Stand bekannt ist und jetzt MEHR erledigt
 * ist (nie beim ersten Laden, nie bei gleichem Stand, nie bei Rückschritt).
 */
export function progressMoment(previousDone: number | null, done: number): boolean {
  return previousDone !== null && done > previousDone;
}

export function isSetupHidden(): boolean {
  try {
    return localStorage.getItem(SETUP_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function hideSetup(): void {
  try {
    localStorage.setItem(SETUP_HIDDEN_KEY, '1');
  } catch {
    // ohne localStorage gilt das Ausblenden nur für diese Sitzung
  }
}

export function readLastDone(): number | null {
  try {
    const v = localStorage.getItem(SETUP_LAST_DONE_KEY);
    if (v === null) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLastDone(n: number): void {
  try {
    localStorage.setItem(SETUP_LAST_DONE_KEY, String(n));
  } catch {
    // unkritisch
  }
}
