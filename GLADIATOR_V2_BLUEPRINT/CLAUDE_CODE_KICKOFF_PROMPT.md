# Kickoff-Prompt für Claude Code

> So benutzt du ihn: Lege ein **neues, leeres** Projektverzeichnis an (z. B. `Gladiator-v2`), kopiere den Ordner `GLADIATOR_V2_BLUEPRINT/` hinein, starte Claude Code in diesem Verzeichnis und füge den Text unten (zwischen den Linien) als erste Nachricht ein. Die **neuen UI-Referenzen** hängst du erst an, wenn Claude Code in der UI-Phase danach fragt.

---

Du bist der leitende Entwickler für den kompletten Neuaufbau von **Gladiator AI v2**, einer KI-gestützten Trading-Agenten-Plattform.

## Quelle der Wahrheit
Im Ordner `GLADIATOR_V2_BLUEPRINT/` liegt die **vollständige, verbindliche Spezifikation** (13 Markdown-Dateien, `00`–`12`). Behandle diese Dateien als **Inhalt UND Arbeitsanweisung** — nicht als Vorschlag. Sie beschreiben Vision, Ist-Analyse, De-Mocking, Zielarchitektur, Strategie-Engine, Börsen-Anbindung (CEX+DEX), Pine/Anweisungen, KI-Agenten, Sicherheit, UI-Struktur und einen Phasen-Bauplan. Bei Widerspruch oder Lücke: **nachfragen, nicht raten.**

## Schritt 1 — Verstehen und Plan vorlegen (NOCH NICHT bauen)
1. Lies **alle** Dateien in `GLADIATOR_V2_BLUEPRINT/` vollständig (Reihenfolge: `00` → `12`).
2. Fasse in einer neuen Datei `PROGRESS.md` dein Verständnis zusammen: Produktziel, die 5 Säulen, was übernommen vs. ersetzt wird, die wichtigsten Risiken.
3. Erstelle eine `CLAUDE.md` im Projekt-Root nach der Vorlage in `11_BUILD_PLAN_CLAUDE_CODE.md` (§3) und ergänze die dort genannten eisernen Regeln.
4. Lege den **Phasenplan** (Phasen 0a–7 aus `11_…`) als Aufgabenliste an.
5. **STOPP danach** und lege mir deine `CLAUDE.md`, `PROGRESS.md` und den Phasenplan zur Abnahme vor. Erst nach meinem „OK" beginnst du mit Phase 0a.

## Sonderregel UI / Oberfläche — WICHTIG
- Das **bisherige Design ist verworfen.** Ignoriere die Beispiel-/Prototyp-Dateien unter `GLADIATOR_V2_BLUEPRINT/design/` (`01_dashboard_mockup.html`, `gladiator_v2_prototype.html`) **vollständig** — weder Optik noch Code übernehmen.
- Aus `09_UI_REDESIGN.md` gilt nur die **funktionale Struktur** (welche Seiten es gibt, welche Daten/Zustände/Interaktionen jede Seite braucht). Die dort genannten **Farben, Schriften, Stil-Beschreibungen sind hinfällig.**
- Das **neue Aussehen** definiere ich über **neue Referenzbilder**, die ich dir in der UI-Phase gebe. Baue **keine** Oberfläche, bevor du diese Referenzen hast. Wenn die UI-Phase (Phase 6) ansteht, fordere die Referenzen aktiv von mir an und leite daraus zuerst ein **Design-System** (Farben, Typografie, Komponenten, Spacing, Motion) ab, das ich abnehme, bevor du Seiten baust.

## Eiserne Regeln (gelten immer)
1. **Kein Fake.** Keine `Math.random()`-Daten, kein Mock/Demo/Platzhalter in Laufpfaden. Nicht verbundene Quellen werden sichtbar als „nicht verbunden" markiert — niemals erfunden. (Mock nur in `__tests__/`.)
2. **Sicherheit zuerst.** Echte Auth/RBAC/Tenant-Scoping; keine Klartext-Secret-Fallbacks; Secrets/Keys im Vault; Risk-Engine als hartes Gate vor jeder Order. Siehe `10_…`.
3. **Paper zuerst.** Alles erst im Paper-/Testnet-Modus. Live wird nur nach expliziter Freigabe pro Börse aktiviert.
4. **Backtests netto.** Keine Strategie-Aussage ohne Gebühren-/Slippage-/Funding-Modell und Look-ahead-/Survivorship-Prüfung (`08_…` §3a/§3b).
5. **TDD.** Erst Tests, dann Code — besonders Risk-Engine, Strategien, Order-Lifecycle, Auth.
6. **Eine Wahrheit.** Ein Backend, ein kanonisches Signal-Datenmodell, eine Strategie-Engine. Keine Doppel-Implementierungen.
7. **Mensch im Loop.** Live-Eskalationen, Limit-Erhöhungen und das Scharfschalten neuer Live-Strategien bestätige ich.
8. **Immer nur EINE Phase**, dann Tests, dann Abnahme durch mich, dann nächste.

## Stack (aus dem Blueprint)
TypeScript · Express + tRPC · Drizzle + PostgreSQL/TimescaleDB · ccxt(pro) · DEX-SDKs (Hyperliquid zuerst, dann dYdX v4; GMX/Bluefin später) · BullMQ + Redis · React + Vite + Tailwind · optionaler Python-Quant-Service (Freqtrade/Jesse). Monorepo-Struktur siehe `04_…` §3.

## Arbeitsweise
- Nested `CLAUDE.md` (Root + pro Paket eine kurze).
- Kontext-Disziplin: pro Phase nur relevante Dateien laden; nach jeder Phase `PROGRESS.md` aktualisieren (was gebaut, was offen, Abweichungen vom Blueprint).
- Vor jeder Phase die zugehörigen Abnahmekriterien (B0a–B7 aus `11_…`) nennen; am Ende belegen, dass sie erfüllt sind (inkl. „0 Treffer" der Mock-Checkliste aus `03_…`).
- Bei jeder Unklarheit oder jedem Konflikt zwischen Spec und Realität: **fragen, nicht annehmen.**

## Deine erste Antwort
Beginne mit Schritt 1: Bestätige kurz dein Verständnis des Produkts (max. 10 Sätze), liste die Phasen, und erstelle `CLAUDE.md` + `PROGRESS.md`. Dann stoppst du und wartest auf meine Abnahme. Baue noch keinen Feature-Code und keine Oberfläche.

---

*Hinweis für später (UI-Phase):* Wenn Claude Code nach den UI-Referenzen fragt, gib ihm deine neuen Bilder mit einem Satz dazu: „Das ist die Zielästhetik für Gladiator AI v2. Leite daraus ein Design-System ab und lege es mir zur Abnahme vor, bevor du Seiten baust."
