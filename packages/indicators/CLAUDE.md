# @gladiator/indicators

Indikator-Bibliothek für Chart, Screener und Alarme — EINE Rechenstelle auf dem Server.
Grundlage: `lightweight-charts-indicators` (MIT; 117 Standard-Indikatoren + 45 Kerzenmuster,
Pine-kompatible Mathematik über `oakscriptjs`, MIT). Die 1.551 Community-Ports werden
BEWUSST NICHT angeboten (Lizenz je Datei unklar bzw. nicht-kommerziell) — Smart Money bleibt
die eigene Engine (`@gladiator/strategy-engine`).

Regeln:
- Rechnung nur hier (Node). Das Paket ist NICHT tree-shakebar (15 MB) und darf nie in
  `apps/web` gebündelt werden; der Browser nutzt nur `lightweight-charts-indicators/render`.
- Eingaben immer über `sanitizeInputs` (Typ, Grenzen, Optionen) — nie rohe Nutzerwerte an `calculate`.
- Kerzenzeiten in Sekunden (lightweight-charts); Chart-Kontext (`leftVisibleBarTime` …) in ms.
- Werte der Standard-Indikatoren sind gegen die Engine-Mathematik auf echten Kerzen getestet
  (EMA/RSI/MACD/Bollinger/ATR) — bei Abweichung: Engine ist die Wahrheit für Signale.
