import type { trpc } from '../api.js';
import { visiblePlotIds, type MenuEntry, type MenuInput } from './indicator-menu.js';

/**
 * Reine Helfer des Markt-Screeners: Standard-Bedingungen, Beschriftung der
 * Bedingungen für Tabellenkopf und Chips, Zahlenformat. Die Form der
 * Bedingungen kommt typgeprüft aus dem Router (`screener.run`).
 */

type RunInput = Parameters<typeof trpc.screener.run.query>[0];
export type Condition = RunInput['conditions'][number];
export type Operand = Extract<Condition, { kind: 'compare' }>['left'];
export type ConditionKind = Condition['kind'];
export type OperandKind = Operand['kind'];
export type CompareOp = Extract<Condition, { kind: 'compare' }>['op'];

export const CONDITION_KINDS: ConditionKind[] = ['compare', 'pattern', 'structure', 'liquidity', 'range'];
export const OPERAND_KINDS: OperandKind[] = ['price', 'indicator', 'number', 'volume', 'volume_avg', 'change'];
export const COMPARE_OPS: CompareOp[] = ['>', '<', '>=', '<=', 'crosses_above', 'crosses_below'];
export const MAX_CONDITIONS = 8;

export function defaultOperand(kind: OperandKind): Operand {
  switch (kind) {
    case 'number':
      return { kind: 'number', value: 30 };
    case 'price':
      return { kind: 'price' };
    case 'volume':
      return { kind: 'volume' };
    case 'change':
      return { kind: 'change', bars: 24 };
    case 'volume_avg':
      return { kind: 'volume_avg', bars: 20, mult: 2 };
    case 'indicator':
      return { kind: 'indicator', id: 'rsi', plot: 'plot0' };
  }
}

export function defaultCondition(kind: ConditionKind): Condition {
  switch (kind) {
    case 'compare':
      return { kind: 'compare', left: { kind: 'indicator', id: 'rsi', plot: 'plot0' }, op: '<', right: { kind: 'number', value: 30 } };
    case 'pattern':
      return { kind: 'pattern', id: 'engulfing-bullish', withinBars: 3 };
    case 'structure':
      return { kind: 'structure', event: 'BOS', direction: 'bullish', withinBars: 5 };
    case 'liquidity':
      return { kind: 'liquidity', what: 'sweep_sell_side', withinBars: 12 };
    case 'range':
      return { kind: 'range', zone: 'discount' };
  }
}

/** Zahlenwertige, sichtbare Eingaben eines Katalog-Eintrags (für die Kurzform im Screener; höchstens vier). */
export function numericInputs(entry: Pick<MenuEntry, 'inputs'>): MenuInput[] {
  return entry.inputs.filter((i) => (i.type === 'int' || i.type === 'float') && i.display !== 'none').slice(0, 4);
}

/** Sichtbare Plots eines Eintrags (Id + Titel) für die Plot-Auswahl. */
export function plotChoices(entry: Pick<MenuEntry, 'plots'>): { id: string; title: string }[] {
  const ids = new Set(visiblePlotIds(entry));
  return entry.plots.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, title: p.title }));
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: abs >= 1000 ? 1 : abs >= 1 ? 2 : 6 });
}

const OP_TEXT: Record<CompareOp, string> = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', crosses_above: '↗', crosses_below: '↘' };

/** Kurzbeschriftung eines Operanden (Indikator-Kürzel + Zahlen-Eingaben, z. B. "EMA 200"). */
export function operandLabel(op: Operand, entryOf: (id: string) => Pick<MenuEntry, 'shortName' | 'inputs' | 'defaultInputs'> | undefined, t: (k: string) => string): string {
  switch (op.kind) {
    case 'number':
      return fmtNum(op.value);
    case 'price':
      return t('screener.op_price');
    case 'volume':
      return t('screener.op_volume');
    case 'change':
      return `Δ% ${op.bars}`;
    case 'volume_avg':
      return `Ø Vol ${op.bars}${op.mult && op.mult !== 1 ? ` × ${fmtNum(op.mult)}` : ''}`;
    case 'indicator': {
      const e = entryOf(op.id);
      if (!e) return op.id;
      const nums = numericInputs(e)
        .map((i) => op.inputs?.[i.id] ?? e.defaultInputs[i.id])
        .filter((v): v is number => typeof v === 'number')
        .map(fmtNum);
      return nums.length > 0 ? `${e.shortName} ${nums.join(' ')}` : e.shortName;
    }
  }
}

/** Kurzbeschriftung einer Bedingung (Tabellenkopf). */
export function conditionLabel(c: Condition, entryOf: (id: string) => Pick<MenuEntry, 'shortName' | 'inputs' | 'defaultInputs'> | undefined, t: (k: string) => string): string {
  switch (c.kind) {
    case 'compare':
      return `${operandLabel(c.left, entryOf, t)} ${OP_TEXT[c.op]} ${operandLabel(c.right, entryOf, t)}`;
    case 'pattern':
      return `${entryOf(c.id)?.shortName ?? c.id} ≤ ${c.withinBars}`;
    case 'structure':
      return `${c.event}${c.direction ? ` ${t(`screener.dir_${c.direction}`)}` : ''} ≤ ${c.withinBars}`;
    case 'liquidity':
      return `${t(`screener.liq_${c.what}`)} ≤ ${c.withinBars}`;
    case 'range':
      return t(`screener.zone_${c.zone}`);
  }
}
