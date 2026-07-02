# apps/web — „Blue Matrix Premium" (Design-Direktive von Patrick, 2026-07-02)

Verbindliche Optik: dunkles, edles Sci-Fi-Command-Center in Blau. Das komplette Design-System
(Farben, Typografie, Glas, Motion, Daten-Rain-Spezifikation) steht in **/DESIGN_SYSTEM.md** —
alle künftigen Seiten (auch Phase 6) folgen diesem System.

Signatur-Effekt: `components/MatrixRain.tsx` — Digital Rain aus ECHTEN SSE-Ticks
(nie Zufallswerte), ein Canvas, rAF, Opacity ≤ 0.25, prefers-reduced-motion beachtet.
Der SSE-Preisstream ist bewusst öffentlich (nur öffentliche Binance-Marktdaten),
damit der Rain auch auf dem Login lebt; alle nutzerbezogenen Endpunkte bleiben geschützt.

Regeln:
- Nur echte Daten oder ehrliche „nicht verbunden"-Zustände — auch „nur fürs Design" keine Fakes.
- Lesbarkeit vor Effekt: AA-Kontrast, Rain konkurriert nie mit Text.
- Ein Signatur-Effekt; sonst Zurückhaltung. Keine Loop-Animation ohne Datenbezug.
- type-only Import von @gladiator/api (AppRouter) — nie Server-Code in den Client bundlen.
- Fonts selbst gehostet (@fontsource) — kein CDN.
- Deutsch als UI-Sprache; i18n kommt mit Phase 6.
