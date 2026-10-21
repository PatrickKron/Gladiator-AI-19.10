import { candlesToBars, catalogEntry, computeIndicator, type ComputeBar } from '@gladiator/indicators';
import { computeSwings, dealingRangeAt, detectLiquidity, detectStructure, type Candle } from '@gladiator/strategy-engine';
import { MIN_CANDLES, type Condition, type Operand } from './conditions.js';

/**
 * Auswertung EINES Symbols gegen die Bedingungen — rein (Kerzen rein, Urteil
 * raus), deterministisch, look-ahead-frei (nur die letzte abgeschlossene Kerze
 * entscheidet, Vergleiche „kreuzt“ brauchen die vorletzte). Indikatoren werden
 * je Lauf einmal gerechnet und über die Bedingungen geteilt.
 */

export type EvalContext = { timeframe: string; tickerid: string };

export type ConditionResult = {
  ok: boolean;
  /** Wert der linken Seite (bzw. Zähler/Position) an der letzten Kerze; null = nicht definiert. */
  left: number | null;
  /** Wert der rechten Seite bei Vergleichen. */
  right: number | null;
  /** Ehrlicher Grund, wenn nicht entscheidbar (zu wenige Kerzen, Indikator-Fehler). */
  note: string | null;
};

export type ScreenResult = {
  matches: boolean;
  close: number;
  /** Veränderung zur vorigen Kerze in Prozent. */
  changePct: number | null;
  /** Zeit der letzten Kerze (Sekunden). */
  time: number;
  results: ConditionResult[];
};

type Series = (number | null)[];

const pct = (now: number, before: number) => (before !== 0 ? ((now - before) / before) * 100 : null);

export class ScreenEvaluator {
  private readonly bars: ComputeBar[];
  private readonly cache = new Map<string, { plots: Record<string, { time: number; value: number }[]>; markers: { time: number }[] } | Error>();
  private swingsCache: ReturnType<typeof computeSwings> | null = null;
  private structureCache: ReturnType<typeof detectStructure> | null = null;
  private liquidityCache: ReturnType<typeof detectLiquidity> | null = null;

  constructor(
    private readonly candles: Candle[],
    private readonly ctx: EvalContext,
  ) {
    this.bars = candlesToBars(candles);
  }

  private indicator(id: string, inputs: Record<string, unknown> | undefined) {
    const key = `${id}:${JSON.stringify(inputs ?? {})}`;
    let hit = this.cache.get(key);
    if (hit === undefined) {
      try {
        const r = computeIndicator(id, this.bars, inputs ?? {}, { timeframe: this.ctx.timeframe, tickerid: this.ctx.tickerid });
        hit = { plots: r.result.plots, markers: (r.result.markers ?? []) as { time: number }[] };
      } catch (e) {
        hit = e instanceof Error ? e : new Error(String(e));
      }
      this.cache.set(key, hit);
    }
    return hit;
  }

  /** Erster sichtbarer Plot eines Katalog-Eintrags (Standard für Vergleiche). */
  static defaultPlot(id: string): string | null {
    const entry = catalogEntry(id);
    const p = entry?.plots.find((x) => x.display !== 'none' && x.color !== 'transparent') ?? entry?.plots[0];
    return p?.id ?? null;
  }

  private series(op: Operand): { values: Series; error: string | null } {
    const n = this.bars.length;
    switch (op.kind) {
      case 'number':
        return { values: Array.from({ length: n }, () => op.value), error: null };
      case 'price':
        return { values: this.bars.map((b) => b.close), error: null };
      case 'volume':
        return { values: this.bars.map((b) => b.volume ?? null), error: null };
      case 'change':
        return { values: this.bars.map((b, i) => (i >= op.bars ? pct(b.close, this.bars[i - op.bars]!.close) : null)), error: null };
      case 'volume_avg': {
        const mult = op.mult ?? 1;
        const out: Series = [];
        let sum = 0;
        for (let i = 0; i < n; i++) {
          sum += this.bars[i]!.volume ?? 0;
          if (i >= op.bars) sum -= this.bars[i - op.bars]!.volume ?? 0;
          out.push(i >= op.bars - 1 ? (sum / op.bars) * mult : null);
        }
        return { values: out, error: null };
      }
      case 'indicator': {
        const r = this.indicator(op.id, op.inputs);
        if (r instanceof Error) return { values: Array.from({ length: n }, () => null), error: r.message };
        const plotId = op.plot ?? ScreenEvaluator.defaultPlot(op.id);
        const pts = plotId ? r.plots[plotId] : undefined;
        if (!pts) return { values: Array.from({ length: n }, () => null), error: `Plot ${plotId ?? '?'} fehlt bei ${op.id}` };
        const byTime = new Map(pts.map((p) => [p.time, p.value]));
        return { values: this.bars.map((b) => byTime.get(b.time) ?? null), error: null };
      }
    }
  }

  private swings() {
    this.swingsCache ??= computeSwings(this.candles);
    return this.swingsCache;
  }

  private structure() {
    this.structureCache ??= detectStructure(this.candles);
    return this.structureCache;
  }

  private liquidity() {
    this.liquidityCache ??= detectLiquidity(this.candles);
    return this.liquidityCache;
  }

  evaluateOne(c: Condition): ConditionResult {
    const n = this.bars.length;
    const last = n - 1;
    if (n < MIN_CANDLES) return { ok: false, left: null, right: null, note: `Zu wenige Kerzen (${n} < ${MIN_CANDLES})` };
    switch (c.kind) {
      case 'compare': {
        const l = this.series(c.left);
        const r = this.series(c.right);
        const error = l.error ?? r.error;
        const lv = l.values[last] ?? null;
        const rv = r.values[last] ?? null;
        if (error) return { ok: false, left: lv, right: rv, note: error };
        if (lv === null || rv === null) return { ok: false, left: lv, right: rv, note: 'Wert an der letzten Kerze nicht definiert' };
        let ok: boolean;
        switch (c.op) {
          case '>':
            ok = lv > rv;
            break;
          case '<':
            ok = lv < rv;
            break;
          case '>=':
            ok = lv >= rv;
            break;
          case '<=':
            ok = lv <= rv;
            break;
          case 'crosses_above':
          case 'crosses_below': {
            const lp = l.values[last - 1] ?? null;
            const rp = r.values[last - 1] ?? null;
            if (lp === null || rp === null) return { ok: false, left: lv, right: rv, note: 'Vorletzte Kerze nicht definiert' };
            ok = c.op === 'crosses_above' ? lp <= rp && lv > rv : lp >= rp && lv < rv;
            break;
          }
        }
        return { ok, left: lv, right: rv, note: null };
      }
      case 'pattern': {
        const r = this.indicator(c.id, undefined);
        if (r instanceof Error) return { ok: false, left: null, right: null, note: r.message };
        const fromTime = this.bars[Math.max(0, n - c.withinBars)]!.time;
        const hits = r.markers.filter((m) => m.time >= fromTime).length;
        return { ok: hits > 0, left: hits, right: null, note: null };
      }
      case 'structure': {
        const from = n - c.withinBars;
        const hits = this.structure().filter((e) => e.index >= from && e.kind === c.event && (c.direction === undefined || e.direction === c.direction));
        return { ok: hits.length > 0, left: hits.length, right: null, note: null };
      }
      case 'liquidity': {
        const liq = this.liquidity();
        const from = n - c.withinBars;
        let hits = 0;
        if (c.what === 'sweep_buy_side' || c.what === 'sweep_sell_side') {
          const side = c.what === 'sweep_buy_side' ? 'buy-side' : 'sell-side';
          hits = liq.sweeps.filter((s) => s.index >= from && s.side === side).length;
        } else {
          const kind = c.what === 'eqh_open' ? 'eqh' : 'eql';
          hits = liq.levels.filter((l) => l.kind === kind && l.sweptAt === undefined && l.brokenAt === undefined && l.confirmedAt <= last && l.index >= from).length;
        }
        return { ok: hits > 0, left: hits, right: null, note: null };
      }
      case 'range': {
        const r = dealingRangeAt(this.candles, this.swings(), last);
        if (!r) return { ok: false, left: null, right: null, note: 'Keine bestätigte Dealing Range' };
        return { ok: r.zone === c.zone, left: Math.round(r.position * 1000) / 10, right: null, note: null };
      }
    }
  }
}

/** Alle Bedingungen eines Symbols (UND-Verknüpfung). */
export function evaluateScreen(candles: Candle[], conditions: Condition[], ctx: EvalContext): ScreenResult {
  const ev = new ScreenEvaluator(candles, ctx);
  const results = conditions.map((c) => ev.evaluateOne(c));
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return {
    matches: results.length > 0 && results.every((r) => r.ok),
    close: last?.close ?? Number.NaN,
    changePct: last && prev ? pct(last.close, prev.close) : null,
    time: last ? Math.floor(last.ts.getTime() / 1000) : 0,
    results,
  };
}
