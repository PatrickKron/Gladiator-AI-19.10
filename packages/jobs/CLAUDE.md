# @gladiator/jobs (Phasen 3+)

BullMQ-Worker (Redis :6380): Markt-Scans, Position-Monitoring, Nacht-Pipeline (Backtests/Optimierung/Briefing), Kalender-Sync.
Regeln: Jobs idempotent + beobachtbar (strukturierte Logs, Metriken); keine losen setInterval-Loops (Alt-Fehler); Fehler → Alarm, nicht Stille. Spec: 04_ §2, 08_ §5/§7.
