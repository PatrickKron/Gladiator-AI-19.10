# apps/web — Design-System v3 „Ruhe & Klarheit" (Freigabe Patrick, 2026-10-21)

Verbindliche Optik: ruhig, dunkel, viel Raum, große Zahlen, EIN Akzent (Elektro-Blau) —
Starlink-Ruhe und Bitpanda-Einfachheit. Das komplette System (Tokens, Typografie, Flächen,
Navigation, Regen-Effekt, Wellenplan) steht in **/DESIGN_SYSTEM.md**. Vorgänger v2 „Blue Matrix"
ist ersetzt.

Signatur-Effekt: `components/MatrixRain.tsx` — Daten-Regen aus ECHTEN SSE-Ticks (nie Zufallswerte),
gesteuert von `components/RainLayer.tsx` + `lib/effects.ts`: nur Login, Ereignis-Impuls,
Bildschirmschoner und (Wahl) Matrix-Modus. Nie dauerhaft hinter Text ohne diese Wahl.
Der SSE-Preisstream ist bewusst öffentlich (nur öffentliche Binance-Marktdaten); alle
nutzerbezogenen Endpunkte bleiben geschützt.

Regeln:
- Nur echte Daten oder ehrliche „nicht verbunden"-Zustände — auch „nur fürs Design" keine Fakes.
- Eine Zahl, eine Hauptaktion je Bildschirm; Komplexes hinter „Erweitert", nie entfernen.
- Vier Farben; Grün/Rot nur für Geld und Richtung. Keine Verläufe, kein Glow, kein Glas.
- Zahlen `.num` (Inter, Tabellenziffern), Mono `.mono` nur für Adressen/Protokoll/Code.
- Zahlen-/Datumsformat IMMER über `appLocale()` (lib/locale.ts), nie Browser-Locale, nie fest „de-DE".
- Eigene CSS-Klassen in `@layer components` (Utilities wie `hidden`/`lg:hidden` müssen gewinnen).
- Navigation nur über die Registry `lib/navigation.ts` (fünf Bereiche, Seiten, Tabs); Links bleiben.
- type-only Import von @gladiator/api (AppRouter) — nie Server-Code in den Client bundlen.
- Fonts selbst gehostet (@fontsource) — kein CDN. i18n: alle Texte über Keys, fünf Sprachen.
- Indikator-Bibliothek: im Browser nur `lightweight-charts-indicators/render` importieren.
