# @gladiator/strategy-engine (Phase 2)

Indikatoren → SMC-Konzepte (BOS/CHoCH, Order/Breaker/Mitigation Block, FVG, Wyckoff, Liquidität) → Strategien → Setup-Kandidaten → ECHTES Confluence-Scoring 0–10. Referenz: SMC Core (Pine-Port, Retest an EMA50/Bruchlevel ist PFLICHT). Multi-Setup scalp/swing/position (ATR-basiert), Session-Gating, Reentry-/Leverage-Upgrade-Engine.
Regeln: kein hartkodierter Score (Alt-Fehler 7.8); Marktstruktur über Swings (pivotHigh/Low), nicht 2-Kerzen-Vergleich; TDD für alle Konzept-Detektoren. Spec: 05_, Abnahme B2.
Liquidität (`liquidity.ts`): Equal Highs/Lows, Sweeps (BSL/SSL), Dealing Range (Premium/Discount) — eigene Umsetzung, look-ahead-frei; im Scoring erst nach Backtest-Messung.
