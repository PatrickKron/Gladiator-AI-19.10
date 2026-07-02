# Gladiator AI v2 — Rebuild-Blueprint

**Für:** Patrick · **Erstellt:** 29.06.2026 · **Zweck:** Aus der heutigen Signal-/Daten-App eine vollständige, echte **Trading-Agenten-Plattform** neu bauen — mit Strategien, CEX- **und** DEX-Anbindung, Pine-Scripts/Anweisungen, proaktiver Strategie-Verbesserung und neuem UI (per Claude Design).

> Dieses Paket ist so geschrieben, dass du es **direkt an Claude Code übergeben** kannst. Jede Datei ist ein eigenständiges Spec-Dokument. Gemeinsam beschreiben sie die komplette App so genau, dass sie von Grund auf neu und **voll funktionsfähig** (kein Mockup) gebaut werden kann.

---

## 0. Das Wichtigste zuerst — bitte JETZT erledigen (Sicherheit)

In deinen alten Dateien liegen **echte Zugangsdaten im Klartext**. Sie gelten als kompromittiert. Bevor irgendetwas neu gebaut wird:

1. **Telegram-Bot-Token neu generieren** (BotFather → `/revoke`). Der alte Token `7544725601:AAF…` steht in mehreren Desktop-Skripten.
2. **OpenAI-API-Key widerrufen** (platform.openai.com → Keys → Revoke). Der alte `sk-proj-…` steht in `devils_analyst.py` / `weekly_analyzer.py`.
3. **OKX-API-Keys löschen** (werden aktuell nicht mal genutzt) — `generate_input.py`.
4. Details und vollständige Liste: **`10_SICHERHEIT_UND_SECRETS.md`**.

---

## 0b. Realistische Erwartung (ehrlich)

Das hier ist ein **Monate-Projekt**, kein Wochenende. Es ist eine vollwertige, handelnde Finanzplattform mit echtem Geld-Risiko. Plane in Phasen (siehe `11_…`), bau zuerst alles in **Paper/Testnet**, und schalte Live erst frei, wenn Risk-Engine, Gebühren-Modell und Monitoring grün sind. Lieber langsam und echt als schnell und fingiert — das ist auch deine eigene Linie („keine atrappen").

Zwei Dinge **vor** dem ersten ernsthaften Backtest bzw. vor Live unbedingt beachten (Details in den jeweiligen Dateien):
- **Backtests ohne Gebühren-/Slippage-/Funding-Modell sind geschönt** (also auch „Fake"). Erst das Modell (`08_…` §3a), dann Vertrauen in Zahlen.
- **Kommerzieller Verkauf von Signalen / Trade-Ausführung für Dritte kann in DE/EU erlaubnispflichtig sein** (BaFin/MiCA). Vor Monetarisierung Rechtsberatung (`10_…` §6).

## 1. So benutzt du dieses Blueprint mit Claude Code (Kurzanleitung)

**Schritt 1 — Repo vorbereiten.** Lege ein **neues, leeres Projektverzeichnis** an (nicht das alte überschreiben), z. B. `Gladiator-v2`. Kopiere diesen Ordner `GLADIATOR_V2_BLUEPRINT/` hinein. Das alte Projekt bleibt als Referenz erhalten.

**Schritt 2 — Claude Code starten** im neuen Ordner. Sag ihm sinngemäß:
> „Lies den gesamten Ordner `GLADIATOR_V2_BLUEPRINT/`. Das ist die verbindliche Spezifikation. Erzeuge zuerst eine `CLAUDE.md` aus `11_BUILD_PLAN_CLAUDE_CODE.md`, dann arbeite **Phase 0** ab und stoppe zur Abnahme."

**Schritt 3 — Phasenweise bauen.** Der Bauplan (`11_…`) ist in Phasen 0–7 geschnitten. Lass Claude Code **immer nur eine Phase** machen, dann testen, dann abnehmen. Nie alles auf einmal — sonst verliert das Modell den Kontext (das ist auch der dokumentierte Best-Practice-Weg).

**Schritt 4 — UI per Claude Design.** Das neue Aussehen ist in **`09_UI_REDESIGN.md`** seitenweise spezifiziert. Diese Datei ist so geschrieben, dass du sie direkt in Claude (Design/Artifacts) einkippen und Seite für Seite Entwürfe generieren lassen kannst.

**Schritt 5 — Echtgeld erst ganz am Ende.** Alles wird zuerst im **Paper-/Testnet-Modus** gebaut und verifiziert. Live-Trading-Schalter kommt erst, wenn die Risk-Engine (siehe `06_…`) steht und grün ist.

---

## 2. Leseempfehlung / Reihenfolge der Dateien

| # | Datei | Was drin steht | Für wen |
|---|-------|----------------|---------|
| 00 | `00_README_START_HIER.md` | Diese Übersicht + deine Kurzanleitung. | Du |
| 01 | `01_VISION_UND_ZIELE.md` | Was Gladiator AI werden soll (verdichtet aus deinen Chats/Docs), mit Quellen. | Du + Claude |
| 02 | `02_IST_ANALYSE.md` | Was heute existiert: Architektur, was echt/was Fake ist, Schwächen — mit Datei:Zeile. | Claude |
| 03 | `03_MOCKUP_BEFREIUNG.md` | Jede Mock-/Fake-Stelle und was stattdessen echt sein muss (Tabelle, priorisiert). | Claude |
| 04 | `04_ZIELARCHITEKTUR.md` | Ziel-Stack, Monorepo, Module, Datenfluss, DB. | Claude |
| 05 | `05_STRATEGIE_ENGINE.md` | Alle Strategien (Smart Money/BOS/CHoCH/OB/FVG/Wyckoff), Scoring, Setups, Reentry. | Claude |
| 06 | `06_BOERSEN_ANBINDUNG.md` | CEX (ccxt) + DEX (Hyperliquid, dYdX, GMX), Wallets, Order-Lifecycle, Risk-Engine. | Claude |
| 07 | `07_PINE_UND_ANWEISUNGEN.md` | Pine-Scripts + natürliche Anweisungen → ausführbare Strategien. | Claude |
| 08 | `08_AGENTEN_UND_SELBSTOPTIMIERUNG.md` | KI-Agenten-Schwarm, echtes Backtesting, proaktive Strategie-Verbesserung. | Claude |
| 09 | `09_UI_REDESIGN.md` | Neues Design, Seite für Seite — direkt für Claude Design. | Du + Claude Design |
| 10 | `10_SICHERHEIT_UND_SECRETS.md` | Secrets rotieren, Auth/RBAC, Vault, Risk-Limits, Compliance. | Du + Claude |
| 11 | `11_BUILD_PLAN_CLAUDE_CODE.md` | Phasenplan 0–7 + Abnahmekriterien + `CLAUDE.md`-Vorlage. | Claude |
| 12 | `12_DOKUMENT_INDEX_UND_REFERENZEN.md` | Vollständiger Index aller Quelldateien (Desktop/Code/Antigravity). | Du + Claude |

---

## 3. Die Idee in drei Sätzen

Heute ist Gladiator AI eine hübsche **Anzeige-App**: sie zeigt Signale und Marktdaten, vieles davon mit Zufallszahlen befüllt, ohne echte Authentifizierung und ohne echtes Trading. **Gladiator AI v2** wird ein **handelnder Agent**: er beobachtet echte Märkte (CEX + DEX), wendet nachvollziehbare Strategien an, lässt einen KI-Schwarm jedes Signal gegenprüfen, führt — wenn du es freigibst — Orders mit harten Risiko-Limits aus, lernt aus echten Ergebnissen und verbessert seine Strategien selbst. Du steuerst alles über ein neu designtes UI **und** über Chat/Anweisungen/Pine-Scripts, bleibst aber immer der Mensch, der jede risikoreiche Aktion final bestätigt.

---

## 4. Goldene Regeln (gelten für den gesamten Neuaufbau)

1. **Kein Fake.** Keine `Math.random()`-Daten, keine Demo-User, keine Attrappen. Wenn etwas (noch) nicht echt ist, wird es **sichtbar als „nicht verbunden" gekennzeichnet** — nicht erfunden. (Das war auch deine eigene rote Linie: „keine atrappen alles muss funktionell sein".)
2. **Sicherheit vor Features.** Echte Auth, Rotation der Keys, Vault für Börsen-Schlüssel, Risk-Limits **vor** der ersten Order.
3. **Paper zuerst.** Jede Strategie/Order zuerst im Testnet/Paper. Live nur per expliziter Freigabe.
4. **Mensch im Loop.** Der Agent darf vorschlagen und (im Rahmen der Limits) ausführen — aber jede neue Live-Strategie und jede Erhöhung der Limits bestätigst du.
5. **Eine Wahrheit.** Ein Backend, ein Signal-Datenmodell, eine Strategie-Engine. Keine drei parallelen Implementierungen mehr (das war ein Hauptproblem der Altlast).

➡️ Weiter mit **`01_VISION_UND_ZIELE.md`**.
