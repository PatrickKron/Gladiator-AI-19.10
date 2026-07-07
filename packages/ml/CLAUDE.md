# @gladiator/ml — Meta-Labeling & Signal Intelligence

ML package implementing Marcos López de Prado's meta-labeling framework:
- **features.ts** — Feature engineering from OHLCV (returns, volatility, momentum, volume, regime)
- **meta-label.ts** — Binary outcome labeling of signals (0=loss, 1=profit)
- **random-forest.ts** — Pure TypeScript Random Forest meta-classifier
- **bet-sizing.ts** — Probability → position size (z-score CDF, 0.1 discretization)
- **truth-core.ts** — Cross-indicator signal validation (anti-hallucination gate)

All computations use real data only. No mocks in runtime paths.
