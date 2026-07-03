import { createHmac, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import { detectStructure, ema, riskClassOf, sessionOf } from '@gladiator/strategy-engine';

const { strategies, signals, auditLog } = schema;

/**
 * Pine-/TradingView-Webhook-Receiver (07_ §1):
 *   Pine-Alert (JSON) → HMAC-Prüfung → bekannte strategyId (kind 'pine')
 *   → Mapping ins kanonische Signal → normaler Weg (Schwarm-Review, Risk-Gate).
 *
 * Sicherheit:
 * - Ohne PINE_WEBHOOK_SECRET ist der Endpunkt ehrlich DEAKTIVIERT (503) —
 *   kein Klartext-Fallback (Regel 2).
 * - Signatur: Header `x-gladiator-signature` = hex(HMAC-SHA256(rawBody, secret)),
 *   timing-safe verglichen. TradingView selbst kann keine Header setzen —
 *   alternativ wird das Feld `secret` IM JSON akzeptiert (ebenfalls timing-safe);
 *   der Wert wird nie geloggt/persistiert.
 * - Alerts werden NIE blind ausgeführt: Signal → Review → Patrick → Risk-Gate.
 */

export const pinePayloadSchema = z.object({
  strategyId: z.string().uuid(),
  symbol: z.string().min(3),
  timeframe: z.enum(['15m', '1h', '4h', '1d']).default('1h'),
  direction: z.enum(['long', 'short']),
  setupType: z.enum(['scalp', 'swing', 'position']).default('swing'),
  entry: z.coerce.number().positive(),
  stopLoss: z.coerce.number().positive(),
  takeProfits: z.array(z.coerce.number().positive()).min(1).max(5),
  leverageSuggested: z.coerce.number().min(1).max(125).default(1),
  /** Optional: eigener Score des Pine-Scripts (0..10). Fehlt er → RR-basiert berechnet. */
  score: z.coerce.number().min(0).max(10).optional(),
  /** Shared-Secret im Body (TradingView kann keine Header setzen). */
  secret: z.string().optional(),
});

export type PinePayload = z.infer<typeof pinePayloadSchema>;

/** TradingView-Ticker wie "BTCUSDT" / "BINANCE:BTCUSDT" → kanonisch "BTC/USDT". */
export function normalizeSymbol(raw: string): string {
  const s = raw.includes(':') ? raw.split(':').pop()! : raw;
  if (s.includes('/')) return s.toUpperCase();
  const upper = s.toUpperCase();
  for (const quote of ['USDT', 'USDC', 'USD', 'BTC', 'ETH']) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return `${upper.slice(0, -quote.length)}/${quote}`;
    }
  }
  return upper;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Prüft Header-HMAC ODER Body-Secret — eines von beiden MUSS stimmen. */
export function verifyPineAuth(rawBody: Buffer, headerSignature: string | undefined, bodySecret: string | undefined, secret: string): boolean {
  if (headerSignature) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (timingSafeEqualStr(headerSignature.toLowerCase(), expected)) return true;
  }
  if (bodySecret) {
    if (timingSafeEqualStr(bodySecret, secret)) return true;
  }
  return false;
}

/**
 * RR-basierter Score für externe Signale OHNE eigenes Scoring: min(10, RR1 × 3),
 * eine Kommastelle. Dokumentierte, echte Berechnung aus den Signal-Feldern —
 * kein erfundener Confluence-Score (Confluence-Analyse gibt es nur engine-seitig).
 */
export function rrBasedScore(entry: number, stopLoss: number, tp1: number, direction: 'long' | 'short'): number {
  const risk = direction === 'long' ? entry - stopLoss : stopLoss - entry;
  if (risk <= 0) return 0;
  const reward = direction === 'long' ? tp1 - entry : entry - tp1;
  if (reward <= 0) return 0;
  return Math.min(10, Math.round((reward / risk) * 30) / 10);
}

/** EMA200-Regime + Marktphase (letztes Struktur-Break) aus ECHTEN eigenen Kerzen. */
async function computeRegime(
  db: Db,
  symbol: string,
  timeframe: string,
): Promise<{ emaRegime: 'above' | 'below'; marketPhase: 'bull' | 'bear' } | null> {
  const candles = await getOhlcv(db, { symbol, timeframe, limit: 400 });
  if (candles.length < 220) return null; // ehrlich: zu wenig Historie
  const closes = candles.map((c) => c.close);
  const ema200 = ema(closes, 200);
  const lastEma = ema200[ema200.length - 1];
  const lastClose = closes[closes.length - 1];
  if (lastEma == null || lastClose == null) return null;
  const events = detectStructure(candles);
  const lastEvent = events[events.length - 1];
  return {
    emaRegime: lastClose >= lastEma ? 'above' : 'below',
    marketPhase: lastEvent ? (lastEvent.direction === 'bullish' ? 'bull' : 'bear') : lastClose >= lastEma ? 'bull' : 'bear',
  };
}

export function pineWebhookHandler(db: Db): express.RequestHandler {
  return (req, res) => {
    void (async () => {
      const secret = process.env.PINE_WEBHOOK_SECRET;
      if (!secret) {
        res.status(503).json({ ok: false, error: 'Pine-Webhook nicht konfiguriert (PINE_WEBHOOK_SECRET fehlt).' });
        return;
      }

      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ ok: false, error: 'Body ist kein gültiges JSON.' });
        return;
      }

      const parsed = pinePayloadSchema.safeParse(parsedJson);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: 'Payload ungültig.', issues: parsed.error.issues });
        return;
      }
      const p = parsed.data;

      const headerSig = req.headers['x-gladiator-signature'];
      if (!verifyPineAuth(rawBody, typeof headerSig === 'string' ? headerSig : undefined, p.secret, secret)) {
        res.status(401).json({ ok: false, error: 'Signatur/Secret ungültig.' });
        return;
      }

      // Bekannte, aktive Pine-Strategie? (07_ §1: nur bekannte strategyId)
      const [strategy] = await db.select().from(strategies).where(eq(strategies.id, p.strategyId)).limit(1);
      if (!strategy || strategy.kind !== 'pine' || !strategy.isActive) {
        res.status(404).json({ ok: false, error: 'strategyId unbekannt, inaktiv oder keine Pine-Strategie.' });
        return;
      }

      const symbol = normalizeSymbol(p.symbol);

      // Plausibilität: SL auf der richtigen Seite
      const slOk = p.direction === 'long' ? p.stopLoss < p.entry : p.stopLoss > p.entry;
      if (!slOk) {
        res.status(422).json({ ok: false, error: 'Stop-Loss liegt auf der falschen Seite des Entrys.' });
        return;
      }

      // Regime aus ECHTEN eigenen Kerzen — ohne Historie kein Risk-Gate-Matching möglich.
      const regime = await computeRegime(db, symbol, p.timeframe);
      if (!regime) {
        res.status(422).json({
          ok: false,
          error: `Zu wenig eigene Kurs-Historie für ${symbol}@${p.timeframe} — Regime/Marktphase nicht bestimmbar (Risk-Gates brauchen sie).`,
        });
        return;
      }

      // Dedupe wie beim Engine-Scan: gleiches offenes Setup nicht doppelt.
      const dup = await db.execute(sql`
        SELECT 1 FROM signals
        WHERE strategy_id = ${p.strategyId} AND symbol = ${symbol} AND timeframe = ${p.timeframe}
          AND direction = ${p.direction} AND setup_type = ${p.setupType} AND status = 'new'
        LIMIT 1
      `);
      if (dup.rows.length > 0) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      const score = p.score ?? rrBasedScore(p.entry, p.stopLoss, p.takeProfits[0]!, p.direction);
      const confluence = p.score !== undefined ? ['extern:pine'] : ['extern:pine', 'score:rr-basiert'];

      const [inserted] = await db
        .insert(signals)
        .values({
          source: 'pine',
          strategyId: p.strategyId,
          symbol,
          timeframe: p.timeframe,
          assetClass: 'crypto',
          venueType: 'cex',
          direction: p.direction,
          setupType: p.setupType,
          entry: String(p.entry),
          stopLoss: String(p.stopLoss),
          takeProfits: p.takeProfits.map(String),
          leverageSuggested: String(p.leverageSuggested),
          score: String(score),
          riskClass: riskClassOf(score),
          confluence,
          session: sessionOf(new Date()),
          emaRegime: regime.emaRegime,
          marketPhase: regime.marketPhase,
          status: 'new',
        })
        .returning({ id: signals.id });

      await db.insert(auditLog).values({
        actor: 'system',
        action: 'signal.pine.received',
        entityType: 'signal',
        entityId: inserted!.id,
        details: { strategyId: p.strategyId, symbol, timeframe: p.timeframe, direction: p.direction, score },
        ip: req.ip ?? null,
      });

      res.status(201).json({ ok: true, signalId: inserted!.id });
    })().catch((err: unknown) => {
      console.error('[pine-webhook]', err);
      res.status(500).json({ ok: false, error: 'Interner Fehler.' });
    });
  };
}
