# apps/web — Design-System v2 „Blue Matrix Premium" (wieder aktiv, Patrick 2026-10-23)

Patrick (2026-10-23): „Version 2 war näher an der Optik … ich möchte aber alle Funktionen von
Version 3 mitnehmen." Verbindliche Optik ist wieder **v2 Blue Matrix**: Nachtblau, zwei Lichtwelten
(Blau/Cyan + Violett/Magenta), Glas-Karten mit Neon-Kante, Neon-CTA (Blau→Violett), Wortmarke mit
Glow, Plexus-Lichtnetz (`components/PlexusHero.tsx`) auf Start und Login, Daten-Regen als
Dauer-Hintergrund (Standard an, abschaltbar), Zahlen in Mono, gesperrte Versal-Labels, Brotkrumen.
Alle v3-Bausteine (fünf Bereiche, Tableiste, Chips, Chat, Werkzeugzeile, „Dein Start“, Schnell-Ticket …)
bleiben und tragen diese Optik. Standard-Modus ist **Profi** (alles sichtbar); „Einfach“ ist eine Wahl.
Weitere Angleichung an Patricks Vorgaben „peu à peu“ — nie eine Funktion entfernen.

Signatur-Effekt: `components/MatrixRain.tsx` — Daten-Regen aus ECHTEN SSE-Ticks (nie Zufallswerte),
gesteuert von `components/RainLayer.tsx` + `lib/effects.ts`: Dauer-Regen (Standard an, wie v2),
Login, Ereignis-Impuls, Bildschirmschoner; abschaltbar unter Profil → Effekte bzw. „g m“.
Der SSE-Preisstream ist bewusst öffentlich (nur öffentliche Binance-Marktdaten); alle
nutzerbezogenen Endpunkte bleiben geschützt.

Regeln:
- Nur echte Daten oder ehrliche „nicht verbunden"-Zustände — auch „nur fürs Design" keine Fakes.
- Eine Zahl, eine Hauptaktion je Bildschirm; Komplexes hinter „Erweitert", nie entfernen.
- v2-Farben (Nachtblau, Blau/Cyan, Violett/Magenta); Grün/Rot für Geld und Richtung. Glas, Neon-Kanten und Glow sind gewollt.
- Zahlen `.num` (JetBrains Mono, Tabellenziffern), `.mono` für Adressen/Protokoll/Code.
- Zahlen-/Datumsformat IMMER über `appLocale()` (lib/locale.ts), nie Browser-Locale, nie fest „de-DE".
- Eigene CSS-Klassen in `@layer components` (Utilities wie `hidden`/`lg:hidden` müssen gewinnen).
- Navigation nur über die Registry `lib/navigation.ts` (fünf Bereiche, Seiten, Tabs); Links bleiben.
- type-only Import von @gladiator/api (AppRouter) — nie Server-Code in den Client bundlen.
- Fonts selbst gehostet (@fontsource) — kein CDN. i18n: alle Texte über Keys, fünf Sprachen.
- Indikator-Bibliothek: im Browser nur `lightweight-charts-indicators/render` importieren.
- Chart-Bedienung wie v2 (Patrick 2026-10-24): neun Ein-Klick-Chips in der Werkzeugzeile, Standard BOS/CHoCH + OB/FVG + RSI an, gespeicherte Wahl gewinnt (`lib/chart-toggles.ts`); Fensterhöhen nur über `lib/chart-panes.ts` (Kursfenster = `mainHeight`, nie fest); EMA/SMA bekommen je eine freie Palettenfarbe (`lib/ma-colors.ts`); v2-Indikatoren aus localStorage werden je Symbol einmal in die DB übernommen (`lib/v2-indicators.ts`). Chart-Seite hat wieder die Tabs Chart · Analyse · Makro · Risiko — Makro/Risiko sind dieselben `MacroPanels`/`RiskPanels` wie in der Marktlage.
- Leer-Zustände: `EmptyState` (ui.tsx) mit ehrlichem Text + EINER Aktion — nie ein leerer Bildschirm ohne nächsten Schritt.
- Einfach/Profi: Registry-Flag `advanced: true` steckt Profi-Seiten hinter „Mehr“ (`subnavPages()`); Komplexes aufklappen, nie entfernen.
- Kontrast: `lib/contrast.test.ts` liest styles.css und erzwingt AA (Text 4,5:1). Volle Blau-Flächen mit weißer Schrift nutzen `--color-blue-solid`.
- UI-Smoke: `e2e/smoke.ts` besucht jede Registry-Route in Einfach/Profi/Handy gegen die laufende App (CI-Job `ui-smoke`; lokal `E2E_CHROMIUM=… npx tsx apps/web/e2e/smoke.ts`). Seitenfehler, kaputte Texte, leere Seiten, Überlauf = rot; ein Überlauf-Befund benennt die überstehenden Elemente, Bildschirmfotos der Routen mit Befund liegen in `e2e-out/` (CI-Artefakt `ui-smoke-befunde`). Merke: ein `<select>` ist so breit wie seine längste Option — lange Platzhalter brauchen `min-w-0 max-w-full` bis hinauf zum Zeilen-Container.
- Asset-Feld (`AssetSelect`): Suchfeld über alle Binance-Spot-Paare (`market.symbolSearch`), Kerzen auf Abruf (`market.ensureCandles`); Aktien/ETF/Forex ab zwei Zeichen über die Yahoo-Suche ohne Key (`market.stockSearch`), Kerzen auf Abruf (`market.ensureStockCandles`, venue `yahoo`) — nie ein Symbol ohne echte Kerzen anzeigen. Beide Wege tragen das Asset ins Asset-Register ein; „Meine Märkte“ zeigt ★ Favoriten ALLER Quellen mit ihrer Quelle (`product.favoriteSymbols`). „+ Markt hinzufügen“ (`AddMarketPicker`) sucht Katalog + Binance + Yahoo und fügt Neues über `product.addAsset` hinzu; Sterne für Nicht-Krypto über `FavStarSymbol venue=…`. Kein TradingView-Logo in Charts (`attributionLogo: false`); die Lizenz-Nennung steht unter Profil → Über und bleibt.
- Demo-Ticket: EINE Komponente `OrderTicket` (views/DemoTrading.tsx) — eigenständig auf der Demo-Seite und `embedded` im Chart („Traden“ klappt es auf). Nie ein zweites Ticket bauen.
- Gladiator-Chat: `components/AssistantPanel.tsx` (Knopf in der Kopfzeile, `openAssistant()` von überall), Stream über `streamAssistant()` in api.ts. Karten zeigen nur echte Werkzeug-Ergebnisse; Bestätigungs-Karten sind der einzige Weg, über den der Chat etwas scharf schaltet. Chat-Einstiege mit vorbelegter Frage: Chart-Kopf, Signalkarte, Screener-Treffer, Analyse-Karten — neue Werkzeugnamen in `TOOL_KEYS` + `assistant.tool_*` eintragen.
