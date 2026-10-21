# @gladiator/jobs (Phasen 3+)

BullMQ-Worker (Redis :6380): Markt-Scans, Position-Monitoring, Nacht-Pipeline (Backtests/Optimierung/Briefing), Kalender-Sync.
Regeln: Jobs idempotent + beobachtbar (strukturierte Logs, Metriken); keine losen setInterval-Loops (Alt-Fehler); Fehler → Alarm, nicht Stille. Spec: 04_ §2, 08_ §5/§7.
Nacht-Optimierung (`optimization.ts`, So 03:00 UTC): je Paper-Strategie (+ SMC Core auf Basis-Symbolen 4h) kleines Grid im Walk-Forward (IS 1000 / OOS 250 Bars, Warmup 250, ≥ 3 OOS-Fenster), Vergleich mit der aktuellen Version auf denselben OOS-Fenstern; nur bei klarem Vorsprung (`judgeOptimization` in @gladiator/backtest) eine Zeile in `optimizations` (status done, `results.review.state` = open) + Audit. Ändert NIE eine Version — übernehmen (→ draft) und promoten macht Patrick.
Screen-Alarme (`screen-alerts.ts`, alle 5 min): gespeicherte Screens mit `alert` auf echten DB-Kerzen rechnen (Auswertung aus @gladiator/indicators, eine Wahrheit mit der Seite) und NUR neue Treffer melden (`screens.last_matches`), Art `screen` über `notifySafe`. Nie Fakes, Fehler je Screen, Lauf geht weiter.
