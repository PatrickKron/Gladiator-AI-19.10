# @gladiator/core

Geteilte Typen und Zod-Schemas — insbesondere das **kanonische Signal-Datenmodell** (`GLADIATOR_V2_BLUEPRINT/04_ZIELARCHITEKTUR.md` §5). Es gibt genau EIN Signal-Modell im System; alle Quellen (Engine, Pine-Webhook, Anweisungs-DSL, manuell) erzeugen dieses Format.

Regeln:
- Jede Typänderung hier ist eine Vertragsänderung für alle Pakete — Tests mitziehen.
- Keine Business-Logik in core, nur Typen/Schemas/kleine reine Helfer.
- `score` ist 0–10 und wird IMMER echt berechnet (nie hartkodiert — Alt-Fehler 7.8).
