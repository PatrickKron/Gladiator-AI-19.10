# @gladiator/risk (Phase 4a — TDD ZUERST)

Hartes Gate vor JEDER Order: Limits (Risiko%/Trade, Hebel-Cap, max. Positionen, Exposure, Tages-/Drawdown-Limit), exaktes Sizing (Tick/Lot/Min-Notional), Margin-Check, SAFE-Kill-Switches (10_ §5a: SAFE-001..010), Dead-Man's-Switch-Hook.
Regeln: reine, deterministische Funktionen; 100% testgetrieben; keine Order-Ausführung hier (nur Urteil). Verbote hart kodiert: keine Auszahlungen/Transfers/Swaps. Spec: 06_ §6, 10_ §5a/§5b, Abnahme B4a.
