# Kompakter One-Shot-Prompt für fable 5 (unter 4000 Zeichen)

> Kopiere NUR den Block zwischen den Linien in fable 5. Er verweist auf die Dateien, statt sie zu wiederholen — das spart Platz. Alle Details stehen in den referenzierten Dokumenten.

---

AUFTRAG: Baue „Gladiator AI" als NEUES, eigenständiges Claude-Code-Projekt (Ordner `gladiator-ai`, eigenes Repo) — ein autonomes Multi-Agenten-Trading- und Finanz-KI-Framework. Handle vision-orientiert und in einem Durchgang (One-Shot), aber sicher im Paper-Modus.

ZUGRIFF: Du hast vollen Lesezugriff auf das Laufwerk. Zwei Quellen sind Pflicht.

1) VERBINDLICHE SPEZIFIKATION (Inhalt UND Arbeitsanweisung) — lies ALLE Dateien in:
`C:\Users\Patrick\Antigravity Gladiator AI versuch 1\GLADIATOR_V2_BLUEPRINT\`
Beginne mit `00_README_START_HIER.md` (Index), dann `01`–`14` (Vision, Ist-Analyse, De-Mocking, Zielarchitektur, Strategie-Engine, Börsen CEX+DEX, Pine/Anweisungen, KI-Agenten & Selbstoptimierung, UI-Design, Sicherheit, Bauplan, Doku-Index, **`13` VDB1/VDB2-Selbstoptimierung mit RAPS**, **`14` optionale Gamification/Alecto**), außerdem `FABLE5_ONESHOT_PROMPT.md` (ausführliche Fassung inkl. Design/Logo) und `CLAUDE_CODE_KICKOFF_PROMPT.md`. Diese Dateien enthalten die komplette Vision, den Funktionsumfang, die Wallet-/Börsen-Logik, das UI-Design und alle Regeln (inkl. konkreter SAFE-Kill-Switch-Schwellen in `10`). Halte dich strikt daran; bei Widerspruch/Lücke: nachfragen, nicht raten.

2) ERNEUTE DESKTOP-RECHERCHE (Pflicht) — durchsuche rekursiv:
`C:\Users\Patrick\Desktop\`
nach allem Projektbezogenen und werte es aus. Suchbegriffe u. a.: gladiator, thaex, chamäleon/chamaelien, trading, strategie, smart money, BOS/CHoCH, order block, pine, block sentinel, devils analyst, okx/binance, telegram, signal, kontext, masterplan, roadmap, pakete. Besonders wichtig: „📄 Master-Kontext für neue Chats.txt", „Funktionierende strategien.txt", „SmartMoney_BOS_CHOCH_Strategy.pine", „06.12.2025 Gladiator_AI_Expanded_Documentation.md", „decker_capital_elite_trading_full_export.md", der Ordner „GladiatorAI\" (Python-Prototypen) und „🧠 Gladiator AI – Backup stuff\". Öffne auch .txt/.md/.pdf/.py/.pine/.ts sowie die ZIP-Archive — besonders „…KI-Trading-Plattform-Konzepts.zip" (enthält u. a. „Gladiator AI 2026 — Blueprint der Dominanz (Single Source of Truth).md" und „F) Compliance & Safety") und „backendinator-complete-code.zip" (Original-Backend, nur als Referenz). Fasse alle Funde in `RESEARCH_NOTES.md` zusammen und speise sie in die Umsetzung ein.

HANDHABUNG DER ALTPROJEKTE: Der Vorgänger unter `...\backend-node\` und `...\frontend-web\` dient NUR als Referenz — kopiere keinen Alt-Code 1:1. Übernimm nur die funktionierenden Teile (ccxt-ExchangeConnector, TradeExecutor, PositionMonitor, UnifiedPriceService) und härte sie; ersetze alles Mock-/`Math.random()`-basierte durch echte Anbindungen (siehe `03_MOCKUP_BEFREIUNG.md`). Lege das neue Projekt in einem SEPARATEN Verzeichnis an und fasse die Altprojekte nicht verändernd an.

EISERNE REGELN (Details in `10_SICHERHEIT_UND_SECRETS.md` + `11_BUILD_PLAN_CLAUDE_CODE.md`): kein Fake/Mock in Laufpfaden — nicht verbundene Quellen sichtbar als „nicht verbunden" markieren; echte Auth/RBAC + Vault, keine Klartext-Secrets; Risk-Engine als hartes Gate vor jeder Order; Wallets/Börsen nur mit Trade-, nie Auszahlrecht; Paper/Testnet zuerst, Live nur nach Freigabe; Backtests netto (Gebühren/Slippage/Funding, look-ahead-frei); TDD; eine Wahrheit (ein Backend, ein Signal-Modell, eine Engine); Mensch im Loop; UI + Logo (futuristischer Maximus-Gladiatorenhelm) gemäß `09_UI_REDESIGN.md` und `FABLE5_ONESHOT_PROMPT.md` §5.

VORGEHEN: (1) Spezifikation lesen + Desktop durchsuchen → erzeuge `RESEARCH_NOTES.md`, `PROGRESS.md` und Projekt-`CLAUDE.md`. (2) Baue in einem Durchgang das vollständige, lauffähige Fundament im Paper-Modus gemäß Blueprint (Marktdaten, Strategie-Engine „SMC Core", Risk-Engine, CEX+DEX-Venue-Interface auf Testnet, Order-Lifecycle, Agenten-Schwarm, Backtesting, Pine/Anweisungs-DSL, neues UI + Logo). (3) Alles noch nicht echt Angebundene ehrlich sichtbar kennzeichnen. Bei Unklarheit: sicherste Annahme treffen, in `PROGRESS.md` notieren, weitermachen. Definition of Done: siehe `FABLE5_ONESHOT_PROMPT.md` §8.

---
