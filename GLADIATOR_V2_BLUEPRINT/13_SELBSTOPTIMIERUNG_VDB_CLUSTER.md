# 13 · Selbstoptimierung: VDB1/VDB2-Cluster-Kern (RAPS)

Vertiefung von `08_…` §5. Quelle: deine eigenen Vorarbeits-Dokumente (`Dokument.rtf` „Signal-Generator/Automatisierer", „THÆX — Vollständige Systemarchitektur", „Blueprint der Dominanz"). Das ist der **präziseste, direkt umsetzbare Optimierungs-Kern** und ersetzt die fingierte Alt-„Studien-KI" durch echte, mathematisch definierte Selbstoptimierung.

---

## 1. Zwei getrennte Wissens-Datenbanken (strikte Governance)

| DB | Rolle | Wer liest | Wer schreibt |
|---|---|---|---|
| **VDB1 — Roh-/Trade-Metrik-DB** | „Eine Zeile = ein Trade" (Studien-Historie) **+** statisches Fach-/Asset-/Makro-Wissen (Pakete, Einstiegszonen) | RAG-Chatbot (nur das statische Wissen), Studien-Agent | Studien-Agent nach jedem Trade-Closure |
| **VDB2 — Erkenntnis-/Parameter-DB** | Pro Cluster: **optimale Parameter + KI-Begründung** | **Live-Signalgenerator** (1×/Tag), Admin-Dashboard | Studien-Agent (Batch 1×/Woche) |

**Harte Regel:** Der **user-facing Chatbot hat KEINEN Zugriff auf VDB2** (Signallogik). Er darf nur das statische Wissen aus VDB1 nutzen. So leakt die Kern-Edge nicht über den Berater-Bot.

## 2. Cluster-Definition (granular)

Ein Cluster ist der Optimierungs-Bucket. Cluster-Key:
```
package_id | asset_symbol | strategy_name | trading_style | timeframe | session_label | market_structure_type
Beispiel: "PKG01 | BTCUSDT | SMC-Core | swing | 4h | London | trend"
```
Pro Cluster werden **eigene** optimale Parameter gelernt — nicht global. Das fehlte der Alt-Engine (die pauschal + zufällig optimierte).

## 3. VDB1 — `study_trades` (Trade-Metriken, echt)

Felder je geschlossenem Trade: `cluster_key`, `entry/exit_ts`, `direction`, `mfe_bps`, `mae_bps`, `r_multiple`, `session`, `market_structure`, Gebühren/Funding/Slippage (netto!), sowie **TP-Schema-Simulationsfelder** `pnl_R_tp_A/B/C/D` (was hätte jedes TP-Schema an R gebracht). Nur **echte** geschlossene Trades bzw. echte Backtests — nie simulierte Zufallsausgänge.

## 4. Der Optimierungs-Lauf (Studien-Agent)

- **Event-basiert:** nach jedem Trade-Closure → Zeile in VDB1.
- **Batch 1×/Woche:** liest 90-Tage-Fenster, gruppiert nach Cluster, optimiert, schreibt VDB2.

Pro Cluster wird eine **Gitter-Simulation** über Hebel- und TP-Schema-Kandidaten gefahren:
- **Hebel-Kandidaten** `L ∈ {1x, 2x, 3x, 5x, 7x, 10x}` (gedeckelt durch Risk-Engine).
- **TP-Schemas** (erweiterbare Registry): `A = 50/30/20`, `B = 60/30/10`, `C = 100 % auf TP1`, `D = Runner/Trailing`.
- Für jede Kombination (L, S) werden **zeitgewichtete** Kennzahlen berechnet (jüngere Trades stärker, `lambda_time_decay`).

**Auswahl:**
```
(L*, S*) = argmax over (L,S) of RAPS_S(L)
  unter Nebenbedingung: Risk ≤ Max-Risk UND liquidation_flag-Quote ≤ Grenze
```

## 5. Kennzahlen (Pflicht, alle netto nach Kosten)

- **RAPS** (Risk-Adjusted Performance Score) = `μ_L / DD_L` — zeitgewichteter Return / gewichteter Drawdown. **Primäres Zielmaß.**
- **Sharpe**, **Sortino** (nur Downside-Dev), **Calmar** = `Annual_Return / MaxDD`.
- **WinRate**, **ProfitFactor**, **Expectancy** = `WinRate·AvgWin_R − LossRate·AvgLoss_R`.
- **liquidation_flag-Quote** als hartes Constraint (nie Hebel wählen, der Liquidationen produziert).

## 6. VDB2 — `study_clusters` (gelernte Parameter)

Felder je Cluster: `cluster_key`, `optimal_leverage (L*)`, `optimal_tp_schema_id (S*)`, `optimal_risk_pct`, `raps_score`, `sharpe`, `sortino`, `calmar`, `winrate`, `profit_factor`, `expectancy`, `trade_count`, `data_window_days`, `lambda_time_decay`, `changelog`, **`causality_explanation`** (natürlichsprachige KI-Begründung, z. B. „Hebel 5x→7x erhöht: Volatilität gesunken, RAPS signifikant höher") + Vektor-Repräsentation für semantische Cluster-Ähnlichkeitssuche.

## 7. Live-Nutzung

Der **Signalgenerator fragt 1×/Tag VDB2** ab und wendet pro Cluster `L*`, `S*`, `optimal_risk_pct` an. **Kein Hard-Override der Core-Logik** — nur konfigurierbare Parameter werden zurückgespielt („Schleifstein"-Prinzip: die Studie schärft die Signalpakete kontinuierlich).

## 8. Sicherungen gegen Overfitting / Low-Sample

- **`MIN_TRADES_PRO_CLUSTER`** (z. B. 50). Darunter: `isLowSampleSize` → **Fallback** auf übergeordneten Cluster oder konservative Defaults.
- **Signifikanzabschätzung** (Vorwoche vs. aktuell), **Alpha-Decay-Markierung**, **Walk-Forward/Out-of-Sample** (aus `08_…` §4) bleibt Pflicht vor Promotion.
- **Holdout** (z. B. 20 %), max. begrenzte Parameteränderung pro Iteration, Diversity-Check.
- **Mensch im Loop:** neue Live-Parameter promotet der Nutzer (Paper-Auto-Promotion erlaubt).

## 9. Transparenz (Admin/Journal)

`causality_explanation` + `changelog` sind im UI sichtbar (Strategy Lab / Journal) — jede Parameteränderung ist nachvollziehbar begründet und auditiert. Das ist die Ehrlichkeits-/Vertrauensschicht.

## 10. Mapping auf Code (aus deiner Systemarchitektur-Doku)

`StudyMetricsCalculator.ts → VDB1 (study_trades)` · `StudyClusterEngine.ts → VDB2 (study_clusters)` · `getOptimalParams()` wird im `confirmTrade`/Signal-Pfad aufgerufen · `LeverageManager` respektiert `L*` und Risk-Cap (INVESTOR-Modus fix 1x).

➡️ Ergänzt `08_AGENTEN_UND_SELBSTOPTIMIERUNG.md`. Datenmodell-Felder in `04_…` §6 entsprechend erweitern.
