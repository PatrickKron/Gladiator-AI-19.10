# @gladiator/agents (Phase 5)

Agenten-Schwarm: Technik/Makro/Shadow/Risk/Devil's-Advocate/Portfolio-Manager. Strukturierte Urteile (AgentVerdict) am Signal. Provider-Router (lokal-first via Ollama für Vorfilter, Cloud für Kernanalyse) + Kosten-Wächter (LLM UND Daten-APIs).
Regeln: Agenten haben NUR Lese-Tools + Vorschläge — Order-Ausführung ist KEIN Agenten-Tool. Ohne Key → Agent deaktiviert + sichtbar markiert (nie Zufallswerte). Alles auditiert. Spec: 08_, Abnahme B5.
- `LlmProvider.chat()` (Werkzeug-Dialog, neutrale Typen `LlmTool`/`LlmContentBlock`) + `guardedChat` mit Tagesbudget — Grundlage des Gladiator-Chats. Werkzeuge definiert und ausgeführt der Aufrufer (api), nie der Provider.
