import { describe, expect, it } from 'vitest';
import { nextStep, progressMoment, SETUP_STEP_LINKS, type SetupStep } from './setup-progress.js';
import { NAV_PAGES, pageForHash, tabForHash } from './navigation.js';

const steps = (done: boolean[]): SetupStep[] =>
  (['risk', 'watch', 'paperTrade', 'notify', 'exchange'] as const).map((id, i) => ({ id, done: done[i] ?? false }));

describe('Einrichtungs-Fortschritt (Welle F)', () => {
  it('nächster Schritt = erster offener in Reihenfolge; alles erledigt → null', () => {
    expect(nextStep(steps([false, false, false, false, false]))).toBe('risk');
    expect(nextStep(steps([true, false, true, false, false]))).toBe('watch');
    expect(nextStep(steps([true, true, true, true, false]))).toBe('exchange');
    expect(nextStep(steps([true, true, true, true, true]))).toBeNull();
  });

  it('Erfolgsmoment nur bei echtem Fortschritt gegenüber dem bekannten Stand', () => {
    expect(progressMoment(null, 3)).toBe(false); // erstes Laden: kein Vergleich, kein Impuls
    expect(progressMoment(2, 2)).toBe(false);
    expect(progressMoment(3, 2)).toBe(false); // Rückschritt (z. B. Demo-Reset) ist kein Erfolg
    expect(progressMoment(2, 3)).toBe(true);
  });

  it('jeder Schritt führt auf eine Seite (und ggf. einen Tab) der Registry', () => {
    for (const href of Object.values(SETUP_STEP_LINKS)) {
      const page = pageForHash(href);
      expect(page, href).not.toBeNull();
      if (href.includes('?tab=')) expect(tabForHash(page!, href), href).not.toBeNull();
    }
    expect(NAV_PAGES.length).toBeGreaterThan(0);
  });
});
