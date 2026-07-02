# @gladiator/exchange (Phasen 4b/4c)

Ein TradingVenue-Interface für ALLE Börsen (CEX via ccxt, DEX via Hyperliquid/dYdX-SDKs). Order-Lifecycle: Idempotenz (clientOrderId), Retry bei TP/SL-Fehler, Reconciliation beim Start (Börse = Wahrheit), Websocket-Fills.
Regeln: Orders NUR nach grünem Risk-Gate (`@gladiator/risk`); niemals Withdraw-Fähigkeit; Paper/Testnet-Default; Position nie ungeschützt offen lassen. Spec: 06_, Abnahmen B4b/B4c.
