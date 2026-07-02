# 05 · Strategie-Engine

Die Strategie-Engine ist das „Denken" von Gladiator AI: aus echten Marktdaten werden nachvollziehbare Setup-Kandidaten mit **echtem** Score. Sie vereint deine dokumentierten Smart-Money-Strategien, die Logik aus dem Pine-Script (die sauberste im Altprojekt) und die Multi-Setup-Idee aus den Python-Prototypen.

> **Wichtigster Befund aus der Alt-Analyse:** Das Pine-Script `SmartMoney_BOS_CHOCH_Strategy.pine` ist konzeptionell die durchdachteste Logik (BOS/CHoCH + EMA200-Trend + **Retest an EMA50/Bruchlevel** + RSI-Band + Volumen-Confluence). Die Python-Generatoren hatten **hartkodierte Scores (7.8)** bzw. **Zufalls-Scores** und eine zu naive 2-Kerzen-Marktstruktur. → In v2 wird die Pine-Logik die **Referenz-Strategie**, Scores werden **echt** berechnet.

---

## 1. Aufbau in Schichten

```
OHLCV (Multi-Timeframe, echt)
  → Indikatoren        (EMA, RSI, MACD, ATR, Volumen-MA, Pivots/Swings)
  → Markt-Konzepte     (BOS, CHoCH, Order Block, Breaker, Mitigation, FVG, Wyckoff-Phasen, Liquidität)
  → Strategien         (kombinieren Konzepte zu Entry/Exit-Regeln)
  → Setup-Kandidaten   (Entry, SL, TP1..n, Richtung, Setup-Typ)
  → Scoring            (Confluence-basiert, 0..10, ECHT)
  → Risk-Vorabprüfung  (siehe 06_)
  → Signal (kanonisch)
```

## 2. Indikatoren (Basis)

`technicalindicators` (vorhanden) + eigene: EMA(20/50/200), RSI(14), MACD(12/26/9), ATR(14), Volumen-MA(20), **Pivot-/Swing-Erkennung** (`pivotHigh/pivotLow`, konfigurierbare Left/Right-Bars — wie im Pine). Marktstruktur **nicht** über 2-Kerzen-Vergleich, sondern über Swings.

## 3. Smart-Money-Konzepte (aus `decker_capital…` + Pine + `Funktionierende strategien.txt`)

| Konzept | Definition (kurz) | Verwendung |
|---|---|---|
| **BOS** (Break of Structure) | Bruch des letzten Swing-Hochs/-Tiefs in Trendrichtung | Trendfortsetzung-Entry |
| **CHoCH** (Change of Character) | Erster Bruch gegen den vorherigen Trend | Trendwechsel-Entry |
| **Order Block (OB)** | Letzte Gegenkerze vor impulsiver Bewegung (Range > 1,5× Vorkerze) | Einstiegszone |
| **Breaker Block** | Gebrochener OB, der als invertierte Zone neu getestet wird | Re-Test-Entry |
| **Mitigation Block** | Zone, in der „eingesperrte" Verlusttrades neutralisiert werden | Einstiegszone |
| **FVG** (Fair Value Gap) | 3-Kerzen-Imbalance (`low > high[2]` bull / `high < low[2]` bear) | Ziel- & Einstiegszone |
| **Wyckoff** | Akkumulation/Distribution, Spring/UTAD | Range-Einstiege |
| **Liquidität** | Buy-/Sell-Side-Liquidität, Equal Highs/Lows | POIs & TP-Platzierung |

## 4. Referenz-Strategie „SMC Core" (portiert aus dem Pine-Script)

Entry-Logik (long; short spiegelbildlich):

```
trendUp     = close > EMA200
swingHigh/Low via pivotHigh/pivotLow (Left=Right=8, konfigurierbar)
bosLong     = Bruch über letztes Swing-High
chochLong   = vorher bearTrend, dann Bruch über Swing-High
retestLong  = nach BOS/CHoCH: Preis fällt auf gebrochenes Level UND nahe EMA50 (low <= EMA50*1.02) UND bullishe Kerze
rsiOk       = RSI im Long-Band (z.B. 30..50)
volOk       = Volumen > Volumen-MA(20)

longEntry   = (bosLong OR chochLong) AND trendUp AND retestLong AND rsiOk AND volOk
```

Der **Retest** (Pullback an EMA50/Bruchlevel) ist Pflicht — genau diese Bedingung fehlte den Python-Generatoren und ist der Hauptqualitätshebel.

## 5. Multi-Setup-Staffel (aus `block_sentinel.py`)

Pro qualifiziertem Entry werden bis zu drei Setups erzeugt — mit eigenen SL/TP-Multiplikatoren (ATR-basiert statt fixer %), Upgrade-Trigger und RR-Minimum:

| Setup | SL (ATR) | TP-Ziele | Reentry-Pullback | Leverage-Upgrade | RR-min |
|---|---|---|---|---|---|
| scalp | eng (≈1,0×ATR) | TP1 1R, TP2 2R | −1,5…−2,0 % | +2 % | 1,2 |
| swing | mittel (≈1,5×ATR) | TP1 1R, TP2 2R, TP3 3R | −1,5…−2,5 % | +5 % | 2,0 |
| position | weit (≈2,5×ATR) | TP1 2R, TP2 3R, TP3 5R+ | −2…−3 % | +7 % | 3,0 |

TP-/Teilprofit-Regeln (aus `decker_capital` S010): TP1 (1:1, 30–50 % Position), TP2 (1:2), TP3 (1:3+, Rest), danach Break-Even/Trailing. **Immer** SL; **nie** SL gegen die Position verschieben; CRV ≥ 1:2; max. 2 % Risiko/Trade.

## 6. Echtes Scoring (ersetzt hartkodiert 7.8 / Zufall)

Score 0–10 aus gewichteter Confluence. Beispiel-Gewichte (kalibrierbar durch Backtesting, `08_…`):

| Faktor | Beitrag |
|---|---|
| Trendrichtung passt (EMA200) | +1,5 |
| BOS/CHoCH bestätigt | +1,5 |
| Gültiger Retest an OB/EMA50 | +2,0 |
| RSI im Zielband | +1,0 |
| Volumen-Bestätigung | +1,0 |
| FVG/Imbalance als Ziel vorhanden | +1,0 |
| Session aktiv (London/NY) | +0,5 |
| RR ≥ 2 | +1,0 |
| Higher-TF-Trend bestätigt (Top-Down) | +1,0 |
| Gegen-Confluence (z. B. nahe Gegen-Liquidität) | −1,0 |

`riskClass`: ≥ 8 → low, 6–7,9 → medium, < 6 → high/Watchlist. **Ausspiel-Routing:** < 7 verworfen; ≥ 7 an Pro+VIP; 7–7,9 zusätzlich Free; ≥ 8 exklusiv (nicht Free) — wie im Alt-Versand, aber jetzt mit echtem Score.

## 7. Multi-Timeframe-Top-Down (aus `Smart Money fragen…`)

Pflicht-Kontextprüfung: Trend auf höherer TF (1W/1D/4H) bestimmt erlaubte Richtung; Entry-Verfeinerung auf 1H/15m/1–5m. Ein Long-Entry auf 15m wird nur ausgespielt, wenn die höhere TF nicht klar bearish ist (Score-Malus sonst).

## 8. Session-Gating (aus `run_blocks.py`)

Aktivierungsfenster Asia/London/New York (UTC-basiert, DST-bewusst). Außerhalb: Scans laufen weiter, aber Signale werden niedriger gewichtet/markiert („off-session"). Konfigurierbar pro Strategie.

## 9. Reentry- & Leverage-Upgrade-Engine (aus `monitor_live_triggers.py`)

Zustandsbehafteter Service, der offene Signale überwacht (Websocket-Preis):
- **Reentry:** triggert im Pullback-Fenster (z. B. Long: −2,0 … −1,5 % unter Entry) → zweite Einstiegschance.
- **Leverage-Upgrade:** Bewegung in Trendrichtung ≥ Trigger (z. B. +3,5 %) → Hebel-Skalierung nach Setup-Typ (scalp ×2/max 20, swing ×1,5/max 10, position ×5/max 50 — **gedeckelt durch Risk-Engine**).
- **Auto-Kill:** Score fällt < 6,5 oder Risk = high → `kill_switch`, Signal entwertet, Meldung.
- **Dedup & Event-Log:** jedes Trigger-Ereignis einmalig, vollständig auditiert.

> Wichtig: In v2 ist das **ein** sauberer Service mit **einem** Datenmodell (Alt-Bug: flaches vs. verschachteltes Reentry-Format → der verschachtelte Pfad feuerte nie).

## 10. Strategie-Registry & Versionierung

Jede Strategie ist ein Modul mit: `id`, `params` (typisiert, Zod), `evaluate(candles, ctx) → SetupKandidat[]`. Parameter-Sätze werden als `strategy_versions` versioniert, damit Backtests/Optimierung (siehe `08_…`) reproduzierbar sind und „beste" Parameter promotbar werden.

## 11. Asset-Abdeckung

Start: BTC, ETH, SOL (Crypto, ccxt). Dann Multi-Asset über die Pakete (`01_…` §4): Aktien/ETF/Forex/Rohstoffe via Yahoo/Polygon/Alpaca, Krypto-Körbe via ccxt. Jede Assetklasse braucht echte OHLCV (kein Random-Walk!) und ggf. angepasste Sessions/Indikator-Parameter.

➡️ Weiter mit **`06_BOERSEN_ANBINDUNG.md`**.
