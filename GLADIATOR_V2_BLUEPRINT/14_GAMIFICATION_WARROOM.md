# 14 · Gamification-Ebene: „War Room" & Alecto (optional, additiv)

Quelle: `Gladiator_AI_Warroom_Blueprint.docx`. **Wichtig:** Das ist eine **zusätzliche Engagement-/Retention-Ebene ÜBER** dem seriösen Trading-Kern — **kein Ersatz** für das Profi-Framework. Das Dokument sagt es selbst: „ist eine Zusatzposition". Sie ist optional und wird nur gebaut, wenn du sie willst; der Trading-Kern funktioniert ohne sie vollständig.

---

## 1. Leitidee

Gladiator AI nicht nur als Werkzeug, sondern als **gamifizierte, soziale „Arena"** für Multi-Asset-Trading: XP, Leveling, Squads und eine KI-Begleiterin **Alecto** motivieren, bilden und binden — **ohne toxischen Druck**. Belohnt wird **Disziplin und Resilienz**, nicht Zocken.

## 2. XP-System (verhaltensbasiert)

Belohnt bewusst risikobewusstes Verhalten:
- Take-Profit erreicht **+100** · **Stop-Loss korrekt gesetzt +30** · Lernvideo abgeschlossen **+50** · Squad-Mitglied unterstützt **+75** · **Comeback nach Drawdown +200** (belohnt Resilienz).
- **Market-Events:** Double-XP bei FOMC/CPI/ETF-Terminen · „Rare Pattern Events" (z. B. CHoCH + RSI < 20) · „Killstreak-Multiplier" ×1,5 ab 3 Erfolgen in Folge.

> Kopplung an die Risk-Engine: XP-Trigger nutzen dieselben Ereignisse (SL gesetzt, TP erreicht, Drawdown-Recovery), die das System ohnehin auditiert — kein Fake, sondern reale Handels-Events.

## 3. Prestige / Leveling (mit echten Rechten)

Level schalten reale Produkt-Vorteile frei → zugleich **Retention- und Monetarisierungshebel**:
- **Lv. 25 Legionär** (Feature-Votings) · **Lv. 50 Centurio** (Squads gründen + Pro-Rabatt) · **Lv. 75 Gladiator** (VIP-Warteliste) · **Lv. 100 Prestige 1** (10 % VIP-Rabatt) · … **Prestige 10 „Arena-Gott"** (25 % Rabatt + exklusive Embleme).

## 4. Sozialer Layer

- **Gamertags** statt Realnamen (Privacy).
- **Squads** (5er-Teams, Leader = höchster Rang), Squad-Chat mit Votings, Squad-XP/Gruppen-Erfolge.
- Freundschaftsanfragen, Emblem-„Flexing".

## 5. Sammelkarten & Embleme

- **Sammelkarten** (Common → Rare → Legendary), z. B. bei +100 % PnL — mit Asset, Zeitpunkt, Setup. Baut auf den bereits geplanten **Signal-Sammelkarten** (`01_…` §4) auf.
- **Ehren-Embleme** auch für Rückschläge: „Kopf hoch" (3 SL in Folge), „Comeback Gladiator", „Mentor's Echo" (Anti-Toxizität).

## 6. Alecto — die KI-Begleiterin

- Persönlicher Companion mit **eigenem Systemprompt/Agent**, klar getrennt vom Analyse-/Devil's-Advocate-Layer (`08_…`).
- Kommentiert Drawdowns **mit Motivation statt Kritik**, triggert Missionen, vergibt Embleme, erzählt Storylines, spricht leistungsabhängig an („Operator, starker Rebound erkannt.").
- Klinkt sich als zusätzlicher Agent in den Schwarm ein — **motivational, nie handels-entscheidend**.

## 7. Guardrails (damit es zu Compliance & „kein Fake" passt)

- **Kein „Trading = Spiel"-Eindruck:** Disclaimer sichtbar; Gamification darf Risiko nicht verharmlosen (siehe `10_…`).
- XP/Level dürfen **niemals** Risk-Limits, Positionsgrößen oder Order-Freigaben beeinflussen — sie sind rein kosmetisch/motivational.
- Keine Anreize zu Overtrading: XP kommt für Disziplin (SL, Lernen, Recovery), nicht für Handelsfrequenz.

## 8. Umsetzung / Reihenfolge

Erst der Trading-Kern (Phasen 0–6, `11_…`), **dann** optional der War-Room-Layer als eigenes Paket (`packages/gamification`) mit eigenen Tabellen (`xp_events`, `levels`, `squads`, `emblems`, `cards`) und Alecto als Agent. Für Community/Investoren-Kommunikation: separate Aufbereitung (Notion/PDF).

➡️ Optionaler Zusatz zu `01_VISION_UND_ZIELE.md`. Nur bauen, wenn ausdrücklich gewünscht.
