/**
 * Kanonische, menschen-/LLM-lesbare Beschreibung der Anweisungs-DSL.
 * EINE Wahrheit für alle Prompts (strategies.dslPreview, Strategie-Workshop) —
 * damit Schema-Erweiterungen nicht in vergessenen Prompt-Kopien veralten.
 * Muss synchron zu `instructionDslSchema` in dsl.ts bleiben (Test erzwingt
 * die Erwähnung jedes Bedingungs-Schlüssels).
 */
export const DSL_SCHEMA_DOC = `{
  "id": "kebab-case-slug",
  "symbol": "BTC/USDT",
  "timeframe": "5m"|"15m"|"30m"|"1h"|"2h"|"4h"|"12h"|"1d"|"1w"|"1M",
  "venueType": "cex"|"dex",
  "direction": "long"|"short",
  "setupType": "scalp"|"swing"|"position",
  "when": {
    "session": "asia"|"london"|"overlap"|"newyork"|"off" (optional),
    "all": [  // 1-10 Bedingungen, UND-verknüpft. Jede Bedingung ist GENAU EINES von:
      {"signal":"BOS"|"CHoCH"},
      {"indicator":"RSI","lt":n,"gt":n,"period":n},  // lt/gt: mind. eines; period optional (Default 14)
      {"trend":"EMA200_up"|"EMA200_down"},
      {"maCross":{"kind":"EMA"|"SMA","fast":n,"slow":n,"cross":"bullish"|"bearish","withinBars":n}},  // fast<slow; withinBars optional (Default 1)
      {"priceVs":{"kind":"EMA"|"SMA","period":n,"is":"above"|"below"}},
      {"macd":{"fast":n,"slow":n,"signal":n,"event":"bullish_cross"|"bearish_cross"|"histogram_positive"|"histogram_negative","withinBars":n}},  // Perioden optional (12/26/9)
      {"bollinger":{"period":n,"mult":n,"event":"close_below_lower"|"close_above_upper"|"close_above_middle"|"close_below_middle"}},  // period/mult optional (20/2)
      {"stochastic":{"kPeriod":n,"dPeriod":n,"smoothK":n,"kLt":n,"kGt":n,"cross":"bullish"|"bearish","withinBars":n}},  // kLt/kGt/cross: mind. eines; Perioden optional (14/3/1)
      {"adx":{"period":n,"gt":n,"lt":n}},  // gt/lt: mind. eines; period optional (14)
      {"supertrend":{"period":n,"mult":n,"direction":"up"|"down"}}  // period/mult optional (10/3)
    ]
  },
  "entry": "market" | "retest@EMA<n>",
  "stopLoss": {"type":"ATR","mult":n} | {"type":"pct","pct":n},
  "takeProfits": [{"rr":n}, ...],  // 1-5 Take-Profits als R-Vielfache
  "trailingStop": {"pct":n},  // optional, 0.1-50: Stop folgt dem besten Kurs im %-Abstand, wird nur enger (Backtest und Live identisch)
  "risk": {"maxLeveragePerTrade":n,"riskPctPerTrade":n}
}`;

/** Ausdrucks-Grenzen der DSL — für ehrliche LLM-Antworten („das kann die DSL nicht"). */
export const DSL_LIMITS_DOC = `Die DSL kann NICHT ausdrücken (ehrlich sagen, nie so tun als ob):
- Trailing-Stops nach ATR oder Indikatoren (nur ein fester %-Abstand via "trailingStop")
- ODER-Verknüpfungen zwischen Bedingungen (nur UND); alternative Szenarien = separate Strategie-Versionen
- Beide Richtungen in EINER Strategie (direction ist long ODER short; für beides: zwei Strategien)
- Pyramiding / Nachkaufen, zeitbasierte Exits, Indikator-basierte Exits (Exits sind SL/TP-basiert)
- Multi-Timeframe-Bedingungen (alle Bedingungen laufen auf dem Strategie-Timeframe)`;
