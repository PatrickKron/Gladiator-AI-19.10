import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { de } from './de.js';
import { en } from './en.js';
import { it } from './it.js';
import { es } from './es.js';
import { fr } from './fr.js';

/**
 * i18n (B6): DE/EN/IT/ES/FR — alle Texte über Keys, kein hartkodierter Text.
 * Sprache wird in localStorage gehalten; Default Deutsch (Patricks Sprache).
 */

export const LANGUAGES = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'gladiator.lang';

export function storedLanguage(): LanguageCode {
  const raw = localStorage.getItem(STORAGE_KEY);
  return LANGUAGES.some((l) => l.code === raw) ? (raw as LanguageCode) : 'de';
}

export function setLanguage(code: LanguageCode): void {
  localStorage.setItem(STORAGE_KEY, code);
  void i18n.changeLanguage(code);
  document.documentElement.lang = code;
}

void i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en },
    it: { translation: it },
    es: { translation: es },
    fr: { translation: fr },
  },
  lng: typeof localStorage !== 'undefined' ? storedLanguage() : 'de',
  fallbackLng: 'de',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
