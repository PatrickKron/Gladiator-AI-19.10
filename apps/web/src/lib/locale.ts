import i18n from 'i18next';

/**
 * EINE Locale für Zahlen, Beträge, Daten und Uhrzeiten — abgeleitet aus der
 * UI-Sprache (Profil), nie aus der Browser-Locale. Vorher liefen drei Regime
 * nebeneinander (Browser-Locale, festes „de-DE", i18n-Sprache), sodass dieselbe
 * Seite „110,000 $" und „100.000 $" zeigte. Rein, getestet.
 */

const REGION: Record<string, string> = {
  de: 'de-DE',
  en: 'en-US',
  it: 'it-IT',
  es: 'es-ES',
  fr: 'fr-FR',
};

/** Sprachcode (auch „de-AT", „en-GB") → Formatierungs-Locale; Unbekanntes → Deutsch (Standardsprache). */
export function localeFor(lang: string | null | undefined): string {
  const base = (lang ?? '').toLowerCase().split('-')[0] ?? '';
  return REGION[base] ?? REGION.de!;
}

/** Aktuelle Formatierungs-Locale der Oberfläche. */
export function appLocale(): string {
  return localeFor(i18n.language);
}
