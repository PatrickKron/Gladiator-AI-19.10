# 01 · Vision & Ziele

Verdichtet aus deinen eigenen Dokumenten und Chats. Quellenangaben in eckigen Klammern verweisen auf Dateien (siehe `12_DOKUMENT_INDEX_UND_REFERENZEN.md`).

---

## 1. Produktvision

**Gladiator AI** ist ein **KI-gestütztes Multi-Asset-Trading-System**, das automatisiert Signale erzeugt, sie über einen KI-Schwarm gegenprüft, in Echtzeit ausspielt und — auf Freigabe — Trades auf zentralen und dezentralen Börsen ausführt, auswertet und seine Strategien selbst verbessert.

Kernaussagen aus deinen Quellen:

- „KI-basiertes Multi-Asset-Signalsystem (Start mit BTC, ETH, SOL)", Ziel: „automatisiert Trading-Signale generiert, filtert, in Echtzeit an Nutzer sendet (Push, Telegram, Web)" und „optional direkte Trade-Ausführung über Börsen-APIs". [Master-Kontext]
- Anspruch ausdrücklich kein Wegwerf-MVP: „eine funktionierende und praktische Lösung die Vollwertig ist erstmal nur auf BTC". [Master-Kontext]
- Skalierung: „bis zu 500 marktübergreifend" Assets, später Gold, Öl, Aktien, Forex; die spätere Doku spricht sogar von „over 1,000 instruments". [Master-Kontext; Gladiator_AI_Expanded_Documentation]
- Doppelzielgruppe: „Einsteiger lernen und verstehen … Profis sich Zeit sparen". [Master-Kontext]
- Mehrsprachig von Beginn: Deutsch, Englisch, Italienisch, Spanisch, Französisch. [Master-Kontext]

## 2. Was sich gegenüber heute ändert (der eigentliche Auftrag)

| Heute (v1) | Gladiator AI v2 (Ziel) |
|---|---|
| Zeigt Signale & Daten an | **Handelt** aktiv — Signale → Entscheidung → Order → Auswertung |
| Viele Werte sind `Math.random()` / Mock | **Nur echte Daten**; nicht-verbundene Quellen werden als solche markiert |
| Nur Lese-Anbindung (Kurse) | **CEX + DEX** mit echter Order-Ausführung und Risk-Engine |
| Eine fixe (teils fingierte) Strategie-Logik | **Strategie-Bibliothek** + eigene Strategien per Pine/Anweisung |
| „Studien-KI" lernt aus Zufallsdaten | **Echtes Backtesting + Walk-Forward + Selbstoptimierung** |
| Kein echtes Login / ein Demo-User | **Echte Auth, Rollen, Mandantentrennung** |
| Statisches Mock-Design | **Neues UI per Claude Design**, seitenweise neu |

## 3. Die fünf Säulen von v2

1. **Strategie-Engine** — nachvollziehbare, getestete Strategien (Smart Money Concepts: Order/Breaker/Mitigation Blocks, FVG, BOS/CHoCH, Wyckoff; Indikator-Confluence; Multi-Setup scalp/swing/hold). → `05_…`
2. **Börsen-Layer (CEX + DEX)** — ein einheitlicher Handels-Adapter über zentrale Börsen (Binance, OKX, Bybit … via ccxt) **und** dezentrale Perp-DEXes (Hyperliquid, dYdX v4, GMX, Bluefin) mit Wallet-/Schlüssel-Sicherheit und harten Risk-Limits. → `06_…`
3. **Pine & Anweisungen** — du kannst Strategien als TradingView-Pine-Script **oder** in natürlicher Sprache vorgeben; das System macht daraus ausführbare, gegengeprüfte Regeln. → `07_…`
4. **KI-Agenten-Schwarm + Selbstoptimierung** — spezialisierte Agenten (Technik, Makro, Manipulation, Risiko, „Devil's Advocate") bewerten jedes Setup; ein Optimierer verbessert Strategien proaktiv aus echten Ergebnissen. → `08_…`
5. **Neues UI + Steuerung** — Kommandozentrale, seitenweise neu designt, steuerbar per Klick **und** per Chat/Anweisung. → `09_…`

## 4. Konkrete funktionale Ziele (aus deinen Docs übernommen)

- **Signal als „Sammelkarte"** mit Farbe/Logo je Gruppe, inkl. Betragsfeld und Bestätigen/Ablehnen **vor** Ausführung. [Master-Kontext]
- **Abostufen Free / Pro / VIP**: Free verzögert & weniger Signale, Pro/VIP Echtzeit + Zusatzfunktionen; einzelne Strategien später als Add-on. [Master-Kontext]
- **Asset-Pakete** als kommerzielle Produktstruktur (TECH33, DAX40, Blue-Chip, Dividenden, REITs, Sektor-/EM-ETFs, Rohstoffe, Forex, Krypto-Körbe, Bonds, Volatilität/Hebel-ETFs, thematische Pakete). [Gladiator_AI_Expanded_Documentation]
- **Multi-Kanal-Ausspielung**: Web-App, Push (Web-Push/FCM), Telegram (Free/Pro/VIP-Gruppen mit Topic-Threads). [Master-Kontext; Tel.GladiatorAI Routing]
- **Re-Entry-Logik** und **Leverage-Upgrade** als eigene Signal-Ereignisse. [Block-Sentinel-Prototyp; monitor_live_triggers.py]
- **Session-Logik** (Asia/London/New York) als Aktivierungsfenster. [run_blocks.py]
- **KI-Multi-Brain**: „Block Sentinel" (Technik) + „Project Oracle" (Makro) + „ShadowGPT" (Manipulation) + „Devil's Analyst" (Gegenprüfung/Lernen). [GladiatorAI_Dokumentation_21_06_2025; devils_analyst.py]
- **Wirtschaftskalender** mit Portfolio-Impact und Hedge-Vorschlägen. [Code: calendar/hedging-Router]
- **Magazin/Insights** (KI-kuratierte News, Sentiment, Wochenrückblick). [Code: magazine-Router]

## 5. Deine roten Linien (verbindlich für v2)

Aus deinen eigenen Aussagen [01-MISSION / CHAMÆLIEN-Docs] — sie gelten 1:1 auch hier:

- **„keine atrappen alles muss funktionell sein"** → kein Fake/Mock in Produktion.
- **„lüge mich nicht an"** → bei Live-Verifikation echte Quellen/Status zeigen, keine geschönten Erfolgsmeldungen.
- **Additiv, nichts kaputtmachen** → v2 entsteht parallel; das laufende v1 bleibt erhalten, bis v2 grün ist.
- **Budget-Bewusstsein** → lokal-first wo möglich, Kosten-Wächter für LLM-/Daten-APIs.
- **Du bleibst Chef** → der Agent schlägt vor und handelt nur im freigegebenen Rahmen; Live-Eskalationen bestätigst du.

## 6. Abgrenzung: Gladiator AI vs. „Chamäleon" (CHAMÆLIEN)

Deine Desktop-Dokumente beschreiben **zwei** Projekte:
- **Gladiator AI** — das Trading-System (dieses Blueprint).
- **CHAMÆLIEN / „Chamäleon"** — eine spätere, viel breitere Vision eines proaktiven KI-Allround-Assistenten („digitaler bester Freund", Kommandozentrale fürs ganze digitale Leben). [CHAMAELIEN-MASTER-DOKUMENT]

Dieses Blueprint fokussiert **Gladiator AI**. Wichtig ist aber: viele **Architektur-Prinzipien aus dem Chamäleon-Projekt sind direkt übertragbar** und werden hier bewusst übernommen — ein einziger Agent-Loop mit Tool-Bus, „kein Fake"-Disziplin, Vault für Secrets, proaktive Nacht-Pipeline (Briefings/Optimierung), Modell-Routing lokal-first. Falls du später beide Projekte zusammenführen willst, ist Gladiator AI v2 so gebaut, dass es als „Trading-Subsystem" in eine Chamäleon-Oberfläche einklinkbar ist (siehe `04_…` §7).

## 7. Optionale Zusatzebene: Gamification (War Room / Alecto)

Aus `Gladiator_AI_Warroom_Blueprint.docx` existiert eine zweite Produktidee: Gladiator AI als **gamifizierte, soziale Arena** (XP, Level, Squads, Sammelkarten, KI-Begleiterin **Alecto**) — als **Zusatzebene über** dem Trading-Kern, nicht als Ersatz. Vollständig beschrieben in **`14_GAMIFICATION_WARROOM.md`**. Wird nur gebaut, wenn du es willst; der Kern funktioniert ohne.

➡️ Weiter mit **`02_IST_ANALYSE.md`**.
