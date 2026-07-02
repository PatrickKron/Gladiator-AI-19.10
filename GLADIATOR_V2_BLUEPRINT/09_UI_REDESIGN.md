# 09 · UI-Redesign (Seite für Seite, für Claude Design)

Diese Datei ist so geschrieben, dass du sie **direkt in Claude (Design/Artifacts)** verwenden kannst. Pro Seite: Zweck, Struktur, Komponenten, Daten (echt!), Interaktionen. Du kannst jede Seite einzeln an Claude geben („Entwirf mir Seite X nach diesem Brief").

> **Grundlage:** Dein Antigravity-„Visual Design Audit" beschreibt die heutige Oberfläche bereits seitenweise (Designsprache: „Deep Space"-Dark, Cyan/Gold/Rot-Akzente, Glassmorphism, Kommandozentrale mit Elementen wie „Sentinel Eye", „Neural Cortex", „Aegis Command"). Wir **behalten die starke Kommandozentralen-Identität**, modernisieren sie aber und — entscheidend — **füllen sie mit echten Daten** statt Mock.

---

## 1. Design-System (gilt für alle Seiten)

> **Designsprache final (aus deinen Referenzbildern, 06/2026):** Schwarz-Gold-Premium mit elektrisch-blauer Energie und **kosmischer Orrery-Optik** (konzentrische Ringe, Lichtströme, Gladiator-Identität). „Deep Space"-Command-Center, edel statt grell.

- **Stil:** Dunkles, fast schwarzes Fundament; gold-gravierte Linien; blau leuchtende Daten-/Energiepunkte; konzentrische „Orrery"-Dials als Signaturelement (Risk/Regime). Präzise, datenreich, ruhig, hochwertig.
- **Farben:** Hintergrund #06070A → #0A0C11 (mit dezenten radialen Gold-/Blau-Glows). Flächen = Glassmorphism mit **gold-getönter** Hairline. Akzente: **Gold** (#E8B84B/#F6D98A, primär/Premium/Marke), **elektrisch-Blau** (#4B93FF, Energie/Daten/Live-Signale), **Grün** (long/positiv), **Rot** (short/Gefahr), **Gelb/Amber** (Warnung). Gold und Blau sind die zwei Leitfarben (max. 2 Rampen), Status-Farben sparsam.
- **Typografie:** **Cinzel** (römisch-gravierte Serife) für Marke/Hero-Headlines („GLADIATOR"), **Rajdhani**/**Orbitron** für UI-Labels & große Werte, **Inter** für Fließtext, **JetBrains Mono** für Logs/Datenströme.
- **Signaturelement:** Orrery-Dial — konzentrische Ringe mit Tick-Marks, langsam rotierend, gold+blau, glühendes Zentrum mit Kennzahl (z. B. GRS, Regime-Score). Wiederkehrend auf Dashboard, Oracle, Hedging.
- **Workflow-Metapher (aus Referenz):** Observe → Simulate → Decide → Timeline. Spiegelt sich in Oracle (Observe), Strategy Lab (Simulate), Signals (Decide/„Decision Pathways"), Backtest-Equity (Timeline).
- **Komponenten-Kit:** Karten (Glass), Gauges/Ringe, Sparklines, Daten-Badges, Status-Pills (ONLINE/OFFLINE/PROCESSING), Terminal-Log-Stream, „Sammelkarten" für Signale (Farbe/Logo je Gruppe — aus deinem Master-Kontext).
- **Bewegung:** subtil (Framer Motion), funktional — Puls bei Risiko, sanftes Reinschieben von Karten. Keine Dauer-Animation ohne Datenbezug.
- **States Pflicht:** **Loading**, **Empty** („keine Daten/nicht verbunden" — ehrlich!), **Error**, **No-Auth**. Nie Fake-Werte als Füllung.
- **Responsiv & mehrsprachig:** DE/EN/IT/ES/FR; Desktop-first, aber mobil nutzbar.
- **Echtzeit:** Live-Daten via WebSocket/SSE (Preise, Logs, Fills) — keine `Math.random()`-Ticker mehr.

## 2. Navigation / App-Shell

Top-Bar: Logo „THÆX / Gladiator AI", Hauptnavigation, User-Menü mit echtem Login-Status & Rolle, Sprach-Switch, globaler Risk-Status (GRS-Ampel), Paper/Live-Schalter (deutlich sichtbar). Linke/teils Sidebar optional.

**Seiten-Inventar (aus dem Audit + v2-Erweiterungen):**
1. Dashboard (Home Base) · 2. Signals (Trading Feed) · 3. Pakete (Trading Universe) · 4. Oracle (Synapse) · 5. Strategy Lab (Studien-KI) · 6. Magazine (Insights) · 7. Calendar (Macro Terminal) · 8. Hedging (Aegis Command) · 9. **Trading & Börsen** (neu: Konten/Positionen/Risk) · 10. Trading Settings · 11. Profile · 12. Auth (Login/Register) · 13. Pricing · **14. Strategie-Builder (neu: Pine/DSL)** · **15. Backtesting/Optimierung (neu)**.

---

## 3. Seiten-Briefs

### 3.1 Dashboard (Home Base)
**Zweck:** Zentraler Überblick. **Struktur:** Hero („Willkommen", AI-Core-Status „Operational"), Market-Ticker (BTC/ETH/SOL/GOLD — **echte** Live-Preise + %), Offene Trades (echte Positionen, sonst Empty-State), Intelligence-Hub (System-Status, Performance-Widget mit echten PnL, AI-Terminal mit **echten** System-Logs, Market-Sentiment Fear&Greed echt), Admin-Panel (nur Rolle Admin). **Weg von v1:** keine hartkodierten Ticker/Latenzen/Fake-Logs.

### 3.2 Signals (Trading Feed)
**Zweck:** Feed aller generierten Setups als **„Sammelkarten"** (Farbe/Logo je Gruppe). Pro Karte: Symbol, Richtung (LONG/SHORT), Setup-Typ, Entry/SL/TP1-3, Score (echt), RiskClass, Confluence-Tags, Session, **Agenten-Urteil** (Daumen/Konfidenz), Tier-Badge (Free/Pro/VIP). Aktionen: **Betrag eingeben → Bestätigen/Ablehnen** (vor Ausführung, aus Master-Kontext), Reentry/Leverage-Upgrade-Hinweise. Filter: Asset, Score, Strategie, Status.

### 3.3 Pakete (Trading Universe)
**Zweck:** Asset-Pakete (TECH33, DAX40, Blue-Chip, Dividenden, REITs, Sektor-/EM-ETFs, Rohstoffe, Forex, Krypto-Körbe, Bonds, Volatilität/Hebel-ETFs, Themen). Grid aus Paket-Karten mit echten Live-Preisen, Detail-Ausklappung mit Asset-Tags, Watchlist/Abo-Toggle, Tier-Gating.

### 3.4 Oracle (Synapse)
**Zweck:** Makro-/Regime-„MRI". Quadranten (Gravity/Pulse/Footprint/DNA), GRS-Score, Paket-Gewichte, Liquidations-Heatmap. **Kritisch:** alle Werte **echt** (FRED/VIX/On-Chain/COT) oder klar „nicht verbunden". `PREVIEW_MODE` raus.

### 3.5 Strategy Lab (Studien-KI)
**Zweck:** Strategie-Performance & Optimierung. Liste der Strategien/Versionen mit echten Metriken (Sharpe/Sortino/MaxDD/WinRate/ProfitFactor), Cluster-Analysen, Optimierungs-Vorschläge der Nacht-Pipeline mit **„Promoten"-Button (deine Bestätigung)**. Charts auf echten Backtest-/Trade-Daten.

### 3.6 Magazine (Insights)
**Zweck:** KI-kuratierte News/Sentiment/Wochenrückblick/Education. Echte Newsquelle (CryptoPanic o. ä.) mit Sentiment-Badges; ohne Key sichtbarer Hinweis.

### 3.7 Calendar (Macro Terminal)
**Zweck:** Wirtschaftskalender mit Impact-Scoring, Portfolio-Auswirkung, Hedge-Vorschlägen, **No-Trade-Fenster** (CPI/Leitzins). Echter Kalender-Feed statt MockMacroProvider.

### 3.8 Hedging (Aegis Command)
**Zweck:** Risiko-Kommandozentrale. Behalte die starke Optik (Sentinel-Eye-Gauge = GRS, Neural-Cortex-Konfidenzringe, Force-Field = Sektor-Druckbalken, Rotation-Advisor, Sentinel-Log). **Aber:** GRS aus echten VIX/DXY/US10Y; Empfehlungen/Logs echt; Shadow-Mode klar als „hypothetisch" gekennzeichnet.

### 3.9 Trading & Börsen (NEU)
**Zweck:** Konten, Positionen, Orders, Risk-Status. Liste verbundener Börsen (CEX/DEX) mit Verbindungsstatus, Balances, offene Positionen (live via Websocket), Order-Historie, **Risk-Cockpit** (aktuelle Limits, Exposure, Tages-PnL, Kill-Switch-Button), Paper/Live-Umschalter pro Börse.

### 3.10 Trading Settings
**Zweck:** Risk-Parameter (Risiko%/Trade, max. Hebel, max. Positionen, Tages-/Drawdown-Limit), bevorzugte Börse, Auto-Close, Benachrichtigungen. Werte greifen direkt in die Risk-Engine.

### 3.11 Profile (Commander Profile)
**Zweck:** Account, Rolle, Abo-Status, API-Keys (für externe Integrationen), Sprache, 2FA. Echte Daten, kein Demo-User.

### 3.12 Auth (Login/Register)
**Zweck:** Echtes Login/Registrieren (E-Mail/Passwort, optional OAuth, 2FA), AGB/Datenschutz-Häkchen. `MOCK_AUTH` existiert nicht mehr.

### 3.13 Pricing
**Zweck:** Free/Pro/VIP-Stufen + Paket-Add-ons. Klar, was je Stufe enthalten ist (Echtzeit vs. verzögert, Anzahl Signale, Strategien, Börsen). Checkout-Anbindung später.

### 3.14 Strategie-Builder (NEU)
**Zweck:** Strategien erstellen/verwalten. Drei Tabs: **Eingebaut** (Parameter justieren), **Pine** (Script hochladen/zuordnen, Webhook-URL + Secret anzeigen), **Anweisung** (Text → DSL-Vorschau → bestätigen). Jede Strategie: „Backtesten"-Button, Status (Paper/Live), Version.

### 3.15 Backtesting/Optimierung (NEU)
**Zweck:** Strategie auf echten Daten testen. Auswahl Symbol/Zeitraum/TF → Lauf → Metriken + Equity-Kurve + Trade-Liste + MFE/MAE. Walk-Forward-Ansicht (In- vs. Out-of-Sample). Vergleich zweier Versionen.

---

## 4. So nutzt du das mit Claude Design

Gib Claude pro Seite: das **Design-System (§1)** + den **Seiten-Brief (§3.x)** + den Satz: „Erzeuge einen hochwertigen, dunklen Command-Center-Entwurf als React/Tailwind-Komponente; nutze realistische Platzhalter klar als Beispiel markiert; baue Loading/Empty/Error-States ein." Iteriere Seite für Seite. Die fertigen Komponenten wandern dann in `apps/web` und werden in Phase 5 (siehe `11_…`) an die echten tRPC-Daten angeschlossen.

## 5. Umsetzungs-Backlog aus deinem UI-Audit (Vorarbeit)

Aus deinen Dokumenten (`B) UI/UX-Mapping`, `E) Wiederbelebung der UI`, `UX-Analyse und Umsetzung.docx`). Grundregel dort: **„Jedes tote Element bekommt eine intelligente Funktion"** — nur 18 % der Elemente waren echt verbunden, 64 % Fake/Mock. Das deckt sich 1:1 mit unserer „kein Fake"-Linie und liefert konkrete Backend-Contracts pro UI-Element.

**Sofort (P0-Bugs, aus dem Audit):**
- Signal-Karten: Naming-Mismatch `strategySignals` vs. `tradingSignals` → Seite lädt endlos. Fix zuerst.
- GRS-Gauge: fehlender Bootstrap → Endlos-Loading. Bootstrap-Log/Init ergänzen.
- Oracle: `PREVIEW_MODE` raus → echte Quadranten statt Mock.

**Pro Element belegen:** Zweck/Nutzerwert, Backend-Contract (Inputs/Outputs/Events), Logik, Metrik. Wiederzubeleben u. a.: Market-Ticker (WS + Sparklines), System-Status (HealthCheck + Kill-Switch), Fear&Greed (News + LLM), Live-Logs (Ringbuffer/WS), Strategy-Stats (WinRate/ProfitFactor/Sharpe), Force-Field (Sektor-Korrelation), Asset-Dropdown (dynamisch). Priorisierung P0/P1/P2 nach Aufwand × Wirkung.

## 6. Zusätzliche UX-Bausteine (aus Vorarbeit übernehmen)

- **Command Palette (Cmd/Ctrl+K)** mit Fuzzy-Suche + Keyboard-Shortcuts (Power-User).
- **Dichte-Umschalter** (Compact/Comfortable/Spacious), Widget-System, Focus-Mode (Personalisierung).
- **Journal/Activity-Feed** (GitHub-Stil, Filter Erfolg/Fehler) + Toasts mit Undo.
- **Skeleton-Screens statt Spinner**; Micro-Interactions dezent (Hover-Lift, 300–450 ms Easing).
- Dynamische Begrüßung („Guten Morgen, Patrick").

## 7. UX-Risiko-Akzeptanzkriterien (Design-Guardrails)

Explizit prüfen (aus deinem Audit): **False Confidence** vermeiden (gemockte Daten dürfen nie „echte Analyse" vortäuschen → „nicht verbunden" zeigen); **Guardrail-Warnungen** bei hohem Risiko; Information-Overload und Action-Paralysis durch Progressive Disclosure begrenzen.

> Hinweis: Ältere UI-Dokumente beschreiben die **CHAMÆLIEN-Emerald-Optik** (`#2AEDC2`). Das ist NICHT die Zielfarbe — es gilt die neue Design-Direktive aus §1 (bzw. deine neuen Referenzen). Übernimm die **Prinzipien und Feature-Specs**, nicht die alten Farbwerte.

➡️ Weiter mit **`10_SICHERHEIT_UND_SECRETS.md`**.
