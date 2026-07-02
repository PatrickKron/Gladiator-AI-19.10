# @gladiator/market-data (Phase 1)

Adapter für ECHTE Marktdaten: ccxt(pro) (Binance/OKX/Bybit inkl. Testnet), Yahoo/Polygon/Alpaca (Aktien/ETF/Forex), FRED (Makro), Wirtschaftskalender, News. OHLCV → Timescale-Hypertable (`@gladiator/db`).
Regeln: NIE synthetische Kerzen/Random-Walk. Quelle nicht verfügbar → Status 'nicht verbunden', keine erfundenen Werte. Rate-Limits beachten (ccxt enableRateLimit, Backoff bei 429/418). Spec: 04_ §4, 06_ §7a, Abnahme B1.
