import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { de } from './de.js';

/**
 * i18n (B6): DE/EN/IT/ES/FR — alle Texte über Keys, kein hartkodierter Text.
 * Sprache wird in localStorage gehalten; Default Deutsch (Patricks Sprache).
 * Performance: nur Deutsch (Default + Fallback) liegt im Start-Bundle; die
 * anderen Kataloge (~75 kB je Sprache) werden erst bei Bedarf nachgeladen.
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

const LOADERS: Record<Exclude<LanguageCode, 'de'>, () => Promise<Record<string, unknown>>> = {
  en: () => import('./en.js').then((m) => m.en),
  it: () => import('./it.js').then((m) => m.it),
  es: () => import('./es.js').then((m) => m.es),
  fr: () => import('./fr.js').then((m) => m.fr),
};

/** Katalog bei Bedarf laden (idempotent); Deutsch ist immer schon da. */
export async function ensureLanguage(code: LanguageCode): Promise<void> {
  if (code === 'de' || i18n.hasResourceBundle(code, 'translation')) return;
  i18n.addResourceBundle(code, 'translation', await LOADERS[code]());
}

export function setLanguage(code: LanguageCode): void {
  localStorage.setItem(STORAGE_KEY, code);
  document.documentElement.lang = code;
  void ensureLanguage(code).then(() => i18n.changeLanguage(code));
}

const initialLanguage: LanguageCode = typeof localStorage !== 'undefined' ? storedLanguage() : 'de';

/** Vor dem ersten Render abwarten (main.tsx) — sonst blitzt kurz Deutsch auf. */
export const i18nReady: Promise<unknown> = i18n
  .use(initReactI18next)
  .init({
    resources: { de: { translation: de } },
    lng: 'de',
    fallbackLng: 'de',
    interpolation: { escapeValue: false },
    returnNull: false,
  })
  .then(() => ensureLanguage(initialLanguage))
  .then(() => i18n.changeLanguage(initialLanguage))
  .catch(() => undefined); // Netzfehler beim Nachladen → Deutsch bleibt (Fallback)

export default i18n;
