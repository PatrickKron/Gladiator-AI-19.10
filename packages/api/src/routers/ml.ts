import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import {
  computeFeatures,
  featureVectorToArray,
  labelSignal,
  trainForest,
  predictForest,
  evaluateForest,
  serializeForest,
  deserializeForest,
  computeBetSize,
  runTruthCore,
  DEFAULT_HYPERPARAMS,
  type TrainingSample,
  type FeatureVector,
} from '@gladiator/ml';
import { protectedProcedure, router } from '../trpc.js';

const { mlFeatures, mlLabels, mlModels, mlPredictions, signals } = schema;

export const mlRouter = router({
  /** Compute features for a symbol/timeframe from current OHLCV data. */
  features: protectedProcedure
    .input(z.object({
      symbol: z.string(),
      timeframe: z.string(),
      venue: z.string().default('binance'),
    }))
    .query(async ({ ctx, input }) => {
      const candles = await getOhlcv(ctx.db, {
        symbol: input.symbol,
        timeframe: input.timeframe,
        venue: input.venue,
        limit: 400,
      });

      const fv = computeFeatures(candles);
      if (!fv) return { features: null, candleCount: candles.length, reason: 'Insufficient candles (need 220+)' };

      // Persist features
      const ts = candles[candles.length - 1]!.ts;
      await ctx.db.insert(mlFeatures)
        .values({
          symbol: input.symbol,
          timeframe: input.timeframe,
          ts,
          features: fv,
        })
        .onConflictDoNothing();

      return { features: fv, candleCount: candles.length, reason: null };
    }),

  /** Label a signal as win/loss based on actual price outcome. */
  labelSignal: protectedProcedure
    .input(z.object({
      signalId: z.string().uuid(),
      maxHoldingBars: z.number().int().min(1).max(500).default(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const [signal] = await ctx.db.select().from(signals)
        .where(eq(signals.id, input.signalId))
        .limit(1);

      if (!signal) return { labeled: false, reason: 'Signal not found' };

      const candles = await getOhlcv(ctx.db, {
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        limit: 1000,
        since: new Date(signal.createdAt.getTime() - 3600_000),
      });

      if (candles.length < 10) {
        return { labeled: false, reason: 'Insufficient candles after signal time' };
      }

      // Find the entry bar (closest to signal creation time)
      let entryBarIndex = 0;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i]!.ts >= signal.createdAt) {
          entryBarIndex = i;
          break;
        }
      }

      const result = labelSignal(candles, {
        direction: signal.direction as 'long' | 'short',
        entryPrice: Number(signal.entry),
        stopLoss: Number(signal.stopLoss),
        takeProfits: signal.takeProfits.map(Number),
        entryBarIndex,
        maxHoldingBars: input.maxHoldingBars,
      });

      if (!result) return { labeled: false, reason: 'Could not determine outcome (insufficient future data)' };

      // Compute features at signal time
      const featureCandles = candles.slice(0, entryBarIndex + 1);
      const fv = computeFeatures(featureCandles);

      await ctx.db.insert(mlLabels).values({
        signalId: signal.id,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        ts: signal.createdAt,
        signalType: signal.setupType,
        signalDirection: signal.direction,
        outcome: result.outcome,
        returnPct: String(result.returnPct),
        holdingBars: result.holdingBars,
        features: fv,
      });

      return { labeled: true, outcome: result.outcome, returnPct: result.returnPct, holdingBars: result.holdingBars, exitReason: result.exitReason };
    }),

  /** Train a meta-classifier on historical labeled signals. */
  trainModel: protectedProcedure
    .input(z.object({
      symbol: z.string().optional(),
      timeframe: z.string().optional(),
      nTrees: z.number().int().min(10).max(500).default(100),
      maxDepth: z.number().int().min(3).max(20).default(10),
    }))
    .mutation(async ({ ctx, input }) => {
      // Fetch labeled data
      let query = ctx.db.select().from(mlLabels).$dynamic();
      const conditions = [];
      if (input.symbol) conditions.push(eq(mlLabels.symbol, input.symbol));
      if (input.timeframe) conditions.push(eq(mlLabels.timeframe, input.timeframe));
      if (conditions.length > 0) query = query.where(and(...conditions));

      const labels = await query;

      // Build training samples from labels that have features
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
          trained: false,
          reason: `Need at least 30 labeled samples, have ${samples.length}`,
          sampleCount: samples.length,
        };
      }

      // 80/20 train/test split
      const splitIdx = Math.floor(samples.length * 0.8);
      const trainSet = samples.slice(0, splitIdx);
      const testSet = samples.slice(splitIdx);

      const hyperparams = {
        ...DEFAULT_HYPERPARAMS,
        nTrees: input.nTrees,
        maxDepth: input.maxDepth,
      };

      const model = trainForest(trainSet, hyperparams);
      const metrics = evaluateForest(model, testSet);
      const serialized = serializeForest(model);

      // Deactivate previous active model for this scope
      await ctx.db.update(mlModels)
        .set({ isActive: false })
        .where(and(
          eq(mlModels.isActive, true),
          input.symbol ? eq(mlModels.symbol, input.symbol) : undefined,
          input.timeframe ? eq(mlModels.timeframe, input.timeframe) : undefined,
        ));

      // Find current max version
      const existing = await ctx.db.select({ version: mlModels.version })
        .from(mlModels)
        .where(and(
          input.symbol ? eq(mlModels.symbol, input.symbol) : undefined,
          input.timeframe ? eq(mlModels.timeframe, input.timeframe) : undefined,
        ))
        .orderBy(desc(mlModels.version))
        .limit(1);

      const nextVersion = (existing[0]?.version ?? 0) + 1;

      const [inserted] = await ctx.db.insert(mlModels).values({
        name: `meta-rf-${input.symbol ?? 'global'}-${input.timeframe ?? 'all'}`,
        version: nextVersion,
        modelType: 'random_forest',
        symbol: input.symbol ?? null,
        timeframe: input.timeframe ?? null,
        hyperparams,
        metrics,
        modelBlob: serialized,
        isActive: true,
      }).returning();

      return {
        trained: true,
        modelId: inserted!.id,
        version: nextVersion,
        sampleCount: samples.length,
        trainSize: trainSet.length,
        testSize: testSet.length,
        metrics,
        oobScore: model.oobScore,
        featureImportance: model.featureImportance,
      };
    }),

  /** Predict meta-label probability + bet size for a signal. */
  predict: protectedProcedure
    .input(z.object({
      signalId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      const [signal] = await ctx.db.select().from(signals)
        .where(eq(signals.id, input.signalId))
        .limit(1);

      if (!signal) return { prediction: null, reason: 'Signal not found' };

      // Find active model
      const [activeModel] = await ctx.db.select().from(mlModels)
        .where(and(
          eq(mlModels.isActive, true),
          eq(mlModels.modelType, 'random_forest'),
        ))
        .orderBy(desc(mlModels.trainedAt))
        .limit(1);

      if (!activeModel?.modelBlob) {
        return { prediction: null, reason: 'No trained model available' };
      }

      // Compute features
      const candles = await getOhlcv(ctx.db, {
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        limit: 400,
      });

      const fv = computeFeatures(candles);
      if (!fv) return { prediction: null, reason: 'Insufficient candles for features' };

      // Run Truth Core
      const truthResult = runTruthCore({
        direction: signal.direction as 'long' | 'short',
        entry: Number(signal.entry),
        stopLoss: Number(signal.stopLoss),
        score: Number(signal.score),
        features: fv,
        candles,
      });

      // Predict
      const model = deserializeForest(activeModel.modelBlob);
      const probability = predictForest(model, featureVectorToArray(fv));
      const modelMetrics = activeModel.metrics as { accuracy?: number } | null;
      const sampleSize = modelMetrics && typeof modelMetrics === 'object' ? 100 : 100;
      const betResult = computeBetSize(probability, sampleSize);

      // Persist prediction
      await ctx.db.insert(mlPredictions).values({
        modelId: activeModel.id,
        signalId: signal.id,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        ts: new Date(),
        probability: String(probability),
        betSize: String(betResult.discretizedSize),
        truthCorePass: truthResult.passed,
        truthCoreReasons: truthResult.reasons,
      });

      return {
        prediction: {
          probability,
          betSize: betResult.discretizedSize,
          zScore: betResult.zScore,
          truthCore: {
            passed: truthResult.passed,
            confidence: truthResult.confidence,
            checks: truthResult.checks,
            reasons: truthResult.reasons,
          },
          model: {
            id: activeModel.id,
            name: activeModel.name,
            version: activeModel.version,
          },
        },
        reason: null,
      };
    }),

  /** Run Truth Core validation on a signal without ML prediction. */
  truthCore: protectedProcedure
    .input(z.object({
      signalId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      const [signal] = await ctx.db.select().from(signals)
        .where(eq(signals.id, input.signalId))
        .limit(1);

      if (!signal) return { result: null, reason: 'Signal not found' };

      const candles = await getOhlcv(ctx.db, {
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        limit: 400,
      });

      const fv = computeFeatures(candles);

      const result = runTruthCore({
        direction: signal.direction as 'long' | 'short',
        entry: Number(signal.entry),
        stopLoss: Number(signal.stopLoss),
        score: Number(signal.score),
        features: fv,
        candles,
      });

      return { result, reason: null };
    }),

  /** Get model performance statistics. */
  modelMetrics: protectedProcedure
    .query(async ({ ctx }) => {
      const models = await ctx.db.select({
        id: mlModels.id,
        name: mlModels.name,
        version: mlModels.version,
        modelType: mlModels.modelType,
        symbol: mlModels.symbol,
        timeframe: mlModels.timeframe,
        metrics: mlModels.metrics,
        hyperparams: mlModels.hyperparams,
        trainedAt: mlModels.trainedAt,
        isActive: mlModels.isActive,
      })
        .from(mlModels)
        .orderBy(desc(mlModels.trainedAt))
        .limit(20);

      return { models };
    }),

  /** Get label statistics (win/loss distribution). */
  labelStats: protectedProcedure
    .input(z.object({
      symbol: z.string().optional(),
      timeframe: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const conditions = [];
      if (input.symbol) conditions.push(eq(mlLabels.symbol, input.symbol));
      if (input.timeframe) conditions.push(eq(mlLabels.timeframe, input.timeframe));

      const labels = await ctx.db.select({
        outcome: mlLabels.outcome,
        returnPct: mlLabels.returnPct,
        signalDirection: mlLabels.signalDirection,
        signalType: mlLabels.signalType,
      })
        .from(mlLabels)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const wins = labels.filter(l => l.outcome === 1).length;
      const losses = labels.filter(l => l.outcome === 0).length;
      const total = labels.length;

      return {
        total,
        wins,
        losses,
        winRate: total > 0 ? wins / total : null,
        byDirection: {
          long: {
            total: labels.filter(l => l.signalDirection === 'long').length,
            wins: labels.filter(l => l.signalDirection === 'long' && l.outcome === 1).length,
          },
          short: {
            total: labels.filter(l => l.signalDirection === 'short').length,
            wins: labels.filter(l => l.signalDirection === 'short' && l.outcome === 1).length,
          },
        },
      };
    }),

  /** Get latest prediction for a signal. */
  latestPrediction: protectedProcedure
    .input(z.object({ signalId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [pred] = await ctx.db.select()
        .from(mlPredictions)
        .where(eq(mlPredictions.signalId, input.signalId))
        .orderBy(desc(mlPredictions.createdAt))
        .limit(1);

      return pred ?? null;
    }),
});
