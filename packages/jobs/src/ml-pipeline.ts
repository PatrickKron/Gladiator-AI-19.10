import { asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv, TIMEFRAME_MS } from '@gladiator/market-data';
import {
  computeFeatures,
  featureVectorToArray,
  FEATURE_MIN_CANDLES,
  labelSignal,
  trainForest,
  evaluateForest,
  serializeForest,
  DEFAULT_HYPERPARAMS,
  type TrainingSample,
  type FeatureVector,
} from '@gladiator/ml';
import { scanUniverse } from './universe.js';
import { loadSourceCandles } from './source-candles.js';
import { SCAN_TIMEFRAMES } from './signal-scan.js';

const { mlFeatures, mlLabels, mlModels, signals } = schema;

export type MlFeatureResult = {
  computed: number;
  skipped: number;
  errors: string[];
};

/**
 * Compute and store features for all tracked symbols × timeframes.
 * Runs periodically to keep the feature store fresh.
 */
export async function computeAllFeatures(db: Db): Promise<MlFeatureResult> {
  const result: MlFeatureResult = { computed: 0, skipped: 0, errors: [] };
  const universe = await scanUniverse(db);

  for (const symbol of universe) {
    for (const timeframe of SCAN_TIMEFRAMES) {
      try {
        const candles = await getOhlcv(db, { symbol, timeframe, limit: 400 });
        const fv = computeFeatures(candles);
        if (!fv) {
          result.skipped++;
          continue;
        }

        const ts = candles[candles.length - 1]!.ts;
        await db.insert(mlFeatures)
          .values({ symbol, timeframe, ts, features: fv })
          .onConflictDoNothing();
        result.computed++;
      } catch (err) {
        result.errors.push(`${symbol}@${timeframe}: ${String(err)}`);
      }
    }
  }

  return result;
}

export type MlAutoLabelResult = {
  labeled: number;
  skipped: number;
  errors: string[];
};

/**
 * `db.execute` (Raw-SQL) liefert `numeric[]`-Spalten als Postgres-Array-Literal
 * (`{61000,62000.5}`), NICHT als JSON — JSON.parse wirft darauf.
 */
export function parsePgNumericArray(raw: string): number[] {
  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => Number(s.replace(/^"|"$/g, '').trim()))
    .filter((n) => Number.isFinite(n));
}

/**
 * Beginn des Kerzen-Fensters für ein Label: genug Historie VOR dem Signal für
 * einen Feature-Vektor (FEATURE_MIN_CANDLES + Puffer für Lücken). Vorher
 * startete das Fenster 1 h vor dem Signal → computeFeatures bekam 1–4 Kerzen,
 * lieferte null, und retrainModel fand nie ein trainierbares Sample.
 */
export function labelHistoryStart(createdAt: Date, timeframe: string): Date {
  const barMs = (TIMEFRAME_MS as Record<string, number>)[timeframe] ?? TIMEFRAME_MS['1h'];
  return new Date(createdAt.getTime() - (FEATURE_MIN_CANDLES + 20) * barMs);
}

/** Features zum Signal-Zeitpunkt: nur Kerzen bis einschließlich Signal (look-ahead-frei), je Kursquelle. */
async function featuresAt(db: Db, venue: string, symbol: string, timeframe: string, at: Date): Promise<FeatureVector | null> {
  const history = await loadSourceCandles(db, { venue, symbol, timeframe, since: labelHistoryStart(at, timeframe), until: at });
  return computeFeatures(history);
}

/**
 * Labels, die vor dem Fix ohne Features gespeichert wurden, nachträglich
 * ergänzen (echte Kerzen aus der DB, nur bis zum Signal-Zeitpunkt).
 */
export async function backfillLabelFeatures(db: Db, limit = 200): Promise<{ filled: number; skipped: number }> {
  const missing = await db
    .select({ id: mlLabels.id, symbol: mlLabels.symbol, timeframe: mlLabels.timeframe, ts: mlLabels.ts, venue: signals.venue })
    .from(mlLabels)
    .leftJoin(signals, eq(signals.id, mlLabels.signalId))
    .where(isNull(mlLabels.features))
    .limit(limit);
  let filled = 0;
  for (const l of missing) {
    const fv = await featuresAt(db, l.venue ?? 'binance', l.symbol, l.timeframe, l.ts);
    if (!fv) continue;
    await db.update(mlLabels).set({ features: fv }).where(eq(mlLabels.id, l.id));
    filled++;
  }
  return { filled, skipped: missing.length - filled };
}

/**
 * Auto-label old signals based on actual price outcomes.
 * Finds signals that have enough future price data but haven't been labeled yet.
 */
export async function autoLabelSignals(db: Db): Promise<MlAutoLabelResult> {
  const result: MlAutoLabelResult = { labeled: 0, skipped: 0, errors: [] };

  // Find signals without labels that are old enough (at least 24h old for outcome determination)
  const cutoff = new Date(Date.now() - 24 * 3600_000);
  const unlabeledSignals = await db.execute(sql`
    SELECT s.id, s.symbol, s.venue, s.timeframe, s.direction, s.entry, s.stop_loss,
           s.take_profits, s.setup_type, s.created_at, s.score
    FROM signals s
    LEFT JOIN ml_labels ml ON ml.signal_id = s.id
    WHERE ml.id IS NULL
      AND s.created_at < ${cutoff}
      AND s.source IN ('engine', 'instruction', 'sub_agent')
    ORDER BY s.created_at DESC
    LIMIT 200
  `);

  for (const row of unlabeledSignals.rows) {
    try {
      const sig = row as Record<string, unknown>;
      const symbol = sig.symbol as string;
      const venue = (sig.venue as string | null) ?? 'binance';
      const timeframe = sig.timeframe as string;
      const direction = sig.direction as 'long' | 'short';
      const entryPrice = Number(sig.entry);
      const stopLoss = Number(sig.stop_loss);
      const rawTps = sig.take_profits;
      const tps: unknown[] = Array.isArray(rawTps) ? rawTps : typeof rawTps === 'string' ? parsePgNumericArray(rawTps) : [];
      const createdAt = new Date(sig.created_at as string);

      // Max holding bars depends on timeframe
      const maxBars = timeframe === '15m' ? 16 : timeframe === '1h' ? 12 : timeframe === '4h' ? 12 : 5;

      // Ausgang (Label) braucht nur die Kerzen AB dem Signal — je Kursquelle (A3; Börsen-4h aus 1h).
      const barMs = (TIMEFRAME_MS as Record<string, number>)[timeframe] ?? 3600_000;
      const candles = await loadSourceCandles(db, {
        venue,
        symbol,
        timeframe,
        since: new Date(createdAt.getTime() - Math.max(barMs, 3600_000)),
        limit: 1000,
      });

      if (candles.length < maxBars + 5) {
        result.skipped++;
        continue;
      }

      // Find entry bar
      let entryBarIndex = 0;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i]!.ts >= createdAt) {
          entryBarIndex = i;
          break;
        }
      }

      const label = labelSignal(candles, {
        direction,
        entryPrice,
        stopLoss,
        takeProfits: tps.map(Number),
        entryBarIndex,
        maxHoldingBars: maxBars,
      });

      if (!label) {
        result.skipped++;
        continue;
      }

      // Features zum Signal-Zeitpunkt aus eigener Vorlauf-Historie (look-ahead-frei)
      const fv = await featuresAt(db, venue, symbol, timeframe, createdAt);

      await db.insert(mlLabels).values({
        signalId: sig.id as string,
        symbol,
        timeframe,
        ts: createdAt,
        signalType: sig.setup_type as string,
        signalDirection: direction,
        outcome: label.outcome,
        returnPct: String(label.returnPct),
        holdingBars: label.holdingBars,
        features: fv,
      });

      result.labeled++;
    } catch (err) {
      result.errors.push(String(err));
    }
  }

  return result;
}

export type MlRetrainResult = {
  retrained: boolean;
  sampleCount: number;
  metrics: Record<string, number> | null;
  reason: string | null;
};

/**
 * Retrain the meta-classifier if enough new labeled data exists.
 * Only retrains if there are at least 30 labeled samples.
 */
export async function retrainModel(db: Db): Promise<MlRetrainResult> {
  await backfillLabelFeatures(db);
  // Chronologisch: Train = ältere 80 %, Test = jüngste 20 % (kein Blick in die Zukunft).
  const labels = await db.select().from(mlLabels).orderBy(asc(mlLabels.ts));

  const samples: TrainingSample[] = [];
  for (const label of labels) {
    if (!label.features) continue;
    const fv = label.features as FeatureVector;
    samples.push({
      features: featureVectorToArray(fv),
      label: label.outcome as 0 | 1,
    });
  }

  if (samples.length < 30) {
    return {
      retrained: false,
      sampleCount: samples.length,
      metrics: null,
      reason: `Need at least 30 labeled samples, have ${samples.length}`,
    };
  }

  // 80/20 split (chronologisch, s. o.)
  const splitIdx = Math.floor(samples.length * 0.8);
  const trainSet = samples.slice(0, splitIdx);
  const testSet = samples.slice(splitIdx);

  const model = trainForest(trainSet, DEFAULT_HYPERPARAMS);
  const metrics = evaluateForest(model, testSet);
  const serialized = serializeForest(model);

  // Deactivate previous models
  await db.update(mlModels).set({ isActive: false }).where(eq(mlModels.isActive, true));

  // Get next version
  const existing = await db.select({ version: mlModels.version })
    .from(mlModels)
    .orderBy(desc(mlModels.version))
    .limit(1);
  const nextVersion = (existing[0]?.version ?? 0) + 1;

  await db.insert(mlModels).values({
    name: `meta-rf-global-auto`,
    version: nextVersion,
    modelType: 'random_forest',
    hyperparams: DEFAULT_HYPERPARAMS,
    metrics,
    modelBlob: serialized,
    isActive: true,
  });

  return {
    retrained: true,
    sampleCount: samples.length,
    metrics: metrics as unknown as Record<string, number>,
    reason: null,
  };
}
