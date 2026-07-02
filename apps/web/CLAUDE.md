# apps/web — Rohbau-Oberfläche (Zwischenstand, Patrick-Entscheidung 2026-07-02)

Patrick wollte früh einen benutzbaren Link. Dieser Rohbau (Vite + React + Tailwind) zeigt NUR echte Daten
(Login via echter Auth, Live-Preise via SSE/Binance-WS, OHLCV aus der eigenen DB) oder ehrliche
„nicht verbunden"-Zustände. Er ist im UI sichtbar als ROHBAU gekennzeichnet.

WICHTIG: Das FINALE Design entsteht weiterhin erst in Phase 6 — Referenzbilder von Patrick anfordern →
Design-System ableiten → Abnahme → dann Seiten neu bauen. Bis dahin: Rohbau funktional erweitern ist ok
(neue Phasen sichtbar machen), aber kein aufwendiges Styling und NICHTS vom alten v1-Design übernehmen.

Konventionen: type-only Import von @gladiator/api (AppRouter) — niemals Server-Code in den Client bundlen.
Deutsch als UI-Sprache; i18n kommt mit Phase 6.
