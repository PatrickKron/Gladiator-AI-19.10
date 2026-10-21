import { z } from 'zod';

/**
 * Markt-Screener (Repo-Masterliste, Phase 2): Bedingungen, die serverseitig über
 * Universum × Zeitrahmen ausgewertet werden — mit DERSELBEN Indikator-Bibliothek
 * wie der Chart (`@gladiator/indicators`) und derselben Smart-Money-Engine
 * (`@gladiator/strategy-engine`). Eine Wahrheit: was der Screener findet, zeigt
 * der Chart mit denselben Zahlen.
 */

export const MAX_CONDITIONS = 8;
/** Höchstens so viele Symbole je Lauf (Rechenzeit; das Universum ist ohnehin klein). */
export const MAX_UNIVERSE = 80;
/** Kerzen je Symbol für die Auswertung (EMA 200 + Puffer). */
export const SCREEN_CANDLES = 300;
/** Unter so vielen Kerzen wird nichts entschieden (ehrlich: zu wenig Daten). */
export const MIN_CANDLES = 30;

export const operandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('price') }).strict(),
  z.object({ kind: z.literal('volume') }).strict(),
  /** Veränderung des Schlusskurses über n Kerzen in Prozent. */
  z.object({ kind: z.literal('change'), bars: z.number().int().min(1).max(200) }).strict(),
  /** Durchschnittsvolumen über n Kerzen × mult (z. B. 2 = doppeltes Durchschnittsvolumen). */
  z.object({ kind: z.literal('volume_avg'), bars: z.number().int().min(2).max(200), mult: z.number().positive().max(100).optional() }).strict(),
  /** Plot eines Katalog-Indikators (Standard: erster sichtbarer Plot). */
  z
    .object({ kind: z.literal('indicator'), id: z.string().max(64), plot: z.string().max(40).optional(), inputs: z.record(z.string().max(64), z.unknown()).optional() })
    .strict(),
]);

export const compareOpSchema = z.enum(['>', '<', '>=', '<=', 'crosses_above', 'crosses_below']);

export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('compare'), left: operandSchema, op: compareOpSchema, right: operandSchema }).strict(),
  /** Kerzenmuster des Katalogs (Gruppe candlestick) in den letzten n Kerzen. */
  z.object({ kind: z.literal('pattern'), id: z.string().max(64), withinBars: z.number().int().min(1).max(50) }).strict(),
  z
    .object({ kind: z.literal('structure'), event: z.enum(['BOS', 'CHoCH']), direction: z.enum(['bullish', 'bearish']).optional(), withinBars: z.number().int().min(1).max(100) })
    .strict(),
  z
    .object({ kind: z.literal('liquidity'), what: z.enum(['sweep_buy_side', 'sweep_sell_side', 'eqh_open', 'eql_open']), withinBars: z.number().int().min(1).max(100) })
    .strict(),
  z.object({ kind: z.literal('range'), zone: z.enum(['premium', 'discount', 'equilibrium']) }).strict(),
]);

export const conditionsSchema = z.array(conditionSchema).min(1).max(MAX_CONDITIONS);

export type Operand = z.infer<typeof operandSchema>;
export type CompareOp = z.infer<typeof compareOpSchema>;
export type Condition = z.infer<typeof conditionSchema>;
