import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de.js';
import { GOTO_KEYS, resolveHotkey, SEQUENCE_MS, VIEW_PREFERENCE_KEYS } from './hotkeys.js';
import { pageForHash } from './navigation.js';

describe('Tastenkürzel', () => {
  it('g, dann Buchstabe → Seite (nur innerhalb des Zeitfensters)', () => {
    expect(resolveHotkey('g', null, 0)).toEqual({ type: 'pending' });
    expect(resolveHotkey('t', 0, 500)).toEqual({ type: 'goto', hash: '#/traden' });
    expect(resolveHotkey('T', 0, 500)).toEqual({ type: 'goto', hash: '#/traden' });
    expect(resolveHotkey('t', 0, SEQUENCE_MS + 1)).toBeNull();
    expect(resolveHotkey('x', 0, 100)).toBeNull();
  });

  it('? = Hilfe, / = Suche, andere Tasten nichts', () => {
    expect(resolveHotkey('?', null, 0)).toEqual({ type: 'help' });
    expect(resolveHotkey('/', null, 0)).toEqual({ type: 'search' });
    expect(resolveHotkey('t', null, 0)).toBeNull();
  });

  it('jedes Ziel ist eine echte Seite mit übersetztem Namen, Buchstaben eindeutig', () => {
    const keys = GOTO_KEYS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const g of GOTO_KEYS) {
      expect(pageForHash(g.hash)).not.toBeNull();
      let cur: unknown = de;
      for (const part of g.labelKey.split('.')) cur = (cur as Record<string, unknown>)[part];
      expect(typeof cur).toBe('string');
    }
  });

  it('Zurücksetzen betrifft nur Ansichts-Merker, nie die Anmeldung', () => {
    expect(VIEW_PREFERENCE_KEYS).not.toContain('gladiator.refreshToken');
    expect(VIEW_PREFERENCE_KEYS.every((k) => k.startsWith('gladiator.'))).toBe(true);
  });
});
