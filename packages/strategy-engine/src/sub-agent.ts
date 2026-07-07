import { z } from 'zod';
import type { Candle } from './types.js';

/**
 * Sub-Agenten-Regel-Engine (Trading-Agenten-Werkstatt).
 *
 * Ein Sub-Agent ist ein benutzerdefinierter, autonomer Trading-Agent mit einer
 * These, eigenen Datenquellen, Ein-/Ausstiegs-Regeln und Risk-Budget. Diese
 * Datei enthält NUR die reine, deterministische Logik:
 *   - `subAgentSpecSchema`  — typisierte Regel-Definition (validierbar, keine Blackbox)
 *   - `evaluateSubAgentEntry` — Einstiegs-Entscheidung aus einem Daten-Snapshot
 *   - `evaluateSubAgentExit`  — agenten-verwaltete Ausstiege (Zeit/Event)
 *
 * KEIN Fake: fehlt eine benötigte Kennzahl (Datenquelle nicht verbunden/frisch),
 * ist sie im Snapshot `null` und die Bedingung schlägt ehrlich fehl — es wird
 * nie ein Wert erfunden. TP%/SL% werden als Schutz-Orders im Order-Lifecycle
 * umgesetzt (nicht hier); dieser Evaluator liefert nur die Preis-Level dafür.
 */

// ── Vergleichs-Baustein: mindestens gt ODER lt ─────────────────────────────
const compareSchema = z
  .object({ gt: z.number().optional(), lt: z.number().optional() })
  .strict()
  .refine((c) => c.gt !== undefined || c.lt !== undefined, 'Vergleich braucht gt oder lt.');
export type Compare = z.infer<typeof compareSchema>;

export const subAgentDataSourceSchema = z.enum(['price', 'macro', 'funding', 'calendar', 'news']);
export type SubAgentDataSource = z.infer<typeof subAgentDataSourceSchema>;

// ── Einstiegs-Regeln je Datenquelle ────────────────────────────────────────
const priceEntrySchema = z
  .object({
    /** Änderung in % über das changeLookback-Fenster (Momentum). */
    changePct24h: compareSchema.optional(),
    /** Aktueller Preis mindestens X % unter dem jüngsten Hoch (Dip-Buying). */
    dipFromHighPct: z.number().positive().max(90).optional(),
    /** Anzahl Bars für das Hoch (Default 20). */
    dipLookback: z.number().int().min(2).max(1000).optional(),
  })
  .strict();

const macroEntrySchema = z
  .object({
    vix: compareSchema.optional(),
    grsLabel: z.enum(['risk-on', 'neutral', 'risk-off']).optional(),
    dxyChangePct20d: compareSchema.optional(),
  })
  .strict();

const fundingEntrySchema = z.object({ rate: compareSchema.optional() }).strict();

const calendarEntrySchema = z
  .object({
    /** Nur handeln, wenn KEIN High-Impact-Event in den nächsten N Minuten liegt. */
    noHighImpactWithinMin: z.number().int().positive().max(10_080).optional(),
    /** Nur handeln, wenn GENAU dann ein High-Impact-Event ansteht (Event-Trader). */
    highImpactWithinMin: z.number().int().positive().max(10_080).optional(),
  })
  .strict();

const newsEntrySchema = z
  .object({
    /** Feuert, wenn eines dieser Keywords in einem frischen News-Titel vorkommt. */
    anyKeyword: z.array(z.string().min(2).max(80)).min(1).max(20).optional(),
    /** Nur News jünger als N Minuten berücksichtigen (Default 120). */
    withinMin: z.number().int().positive().max(10_080).default(120),
  })
  .strict();

const entryRulesSchema = z
  .object({
    price: priceEntrySchema.optional(),
    macro: macroEntrySchema.optional(),
    funding: fundingEntrySchema.optional(),
    calendar: calendarEntrySchema.optional(),
    news: newsEntrySchema.optional(),
  })
  .strict();

// ── Ausstiegs-Regeln ───────────────────────────────────────────────────────
const exitRulesSchema = z
  .object({
    /** Take-Profit in % vom Entry (Pflicht — Schutz-Order). */
    takeProfitPct: z.number().positive().max(500),
    /** Stop-Loss in % vom Entry (Pflicht — Schutz-Order). */
    stopLossPct: z.number().positive().max(90),
    /** Agenten-verwaltet: Position nach N Stunden schließen. */
    maxHoldHours: z.number().positive().max(24 * 365).optional(),
    /** Agenten-verwaltet: bei einem dieser News-Keywords sofort schließen (Event-Exit). */
    exitOnNewsKeyword: z.array(z.string().min(2).max(80)).min(1).max(20).optional(),
  })
  .strict();

const riskParamsSchema = z
  .object({
    riskPctPerTrade: z.number().positive().max(5).default(1),
    maxLeverage: z.number().min(1).max(10).default(1),
    /** Max. gleichzeitig offene Positionen dieses Agenten. */
    maxConcurrentPositions: z.number().int().min(1).max(50).default(1),
    /** Agenten-Tagesverlust in % (Paper-Startkapital); überschritten → Agent pausiert. */
    maxDailyLossPct: z.number().positive().max(50).default(5),
    /** Mindestabstand zwischen zwei Einstiegen desselben Symbols (Minuten). */
    cooldownMinutes: z.number().int().min(0).max(10_080).default(60),
  })
  .strict();

export const subAgentSpecSchema = z
  .object({
    side: z.enum(['long', 'short']).default('long'),
    setupType: z.enum(['scalp', 'swing', 'position']).default('swing'),
    timeframe: z.enum(['15m', '1h', '4h', '1d']).default('1h'),
    dataSources: z.array(subAgentDataSourceSchema).min(1),
    entryRules: entryRulesSchema,
    exitRules: exitRulesSchema,
    riskParams: riskParamsSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    // (1) Mindestens EINE konkrete Einstiegsbedingung — sonst würde der Agent dauerfeuern.
    const conds = countEntryConditions(spec.entryRules);
    if (conds === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entryRules: mindestens eine konkrete Bedingung nötig.', path: ['entryRules'] });
    }
    // (2) Jede referenzierte Datenquelle muss in dataSources deklariert sein (Transparenz).
    const declared = new Set(spec.dataSources);
    for (const key of ['price', 'macro', 'funding', 'calendar', 'news'] as const) {
      if (spec.entryRules[key] && !declared.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dataSources fehlt "${key}", obwohl entryRules es verwendet.`,
          path: ['dataSources'],
        });
      }
    }
    // (3) News-Exit braucht die News-Quelle.
    if (spec.exitRules.exitOnNewsKeyword && !declared.has('news')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exitOnNewsKeyword braucht "news" in dataSources.', path: ['dataSources'] });
    }
  });

export type SubAgentSpec = z.infer<typeof subAgentSpecSchema>;
export type SubAgentEntryRules = z.infer<typeof entryRulesSchema>;
export type SubAgentExitRules = z.infer<typeof exitRulesSchema>;
export type SubAgentRiskParams = z.infer<typeof riskParamsSchema>;

export type SubAgentSpecParseResult = { ok: true; spec: SubAgentSpec } | { ok: false; errors: string[] };

export function parseSubAgentSpec(input: unknown): SubAgentSpecParseResult {
  const r = subAgentSpecSchema.safeParse(input);
  if (r.success) return { ok: true, spec: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

function countEntryConditions(rules: SubAgentEntryRules): number {
  let n = 0;
  if (rules.price) {
    if (rules.price.changePct24h) n++;
    if (rules.price.dipFromHighPct !== undefined) n++;
  }
  if (rules.macro) {
    if (rules.macro.vix) n++;
    if (rules.macro.grsLabel) n++;
    if (rules.macro.dxyChangePct20d) n++;
  }
  if (rules.funding?.rate) n++;
  if (rules.calendar) {
    if (rules.calendar.noHighImpactWithinMin !== undefined) n++;
    if (rules.calendar.highImpactWithinMin !== undefined) n++;
  }
  if (rules.news?.anyKeyword) n++;
  return n;
}

// ── Daten-Snapshot: was der Agent im Moment der Auswertung „sieht" ──────────
export type SubAgentNewsItem = { title: string; ageMin: number };

export type SubAgentSnapshot = {
  symbol: string;
  /** Aktueller Preis (echt). */
  price: number;
  /** 24h-/Lookback-Änderung in % — null, wenn nicht ermittelbar. */
  changePct24h: number | null;
  /** Jüngstes Hoch im Dip-Lookback-Fenster — null, wenn zu wenig Historie. */
  recentHigh: number | null;
  vix: number | null;
  grsLabel: 'risk-on' | 'neutral' | 'risk-off' | null;
  dxyChangePct20d: number | null;
  fundingRate: number | null;
  /** Minuten bis zum nächsten High-Impact-Event (null = keines im Horizont). */
  minutesToNextHighImpact: number | null;
  recentNews: SubAgentNewsItem[];
  now: Date;
};

export type SubAgentEntryDecision = {
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  /** Nachvollziehbare Gründe (welche Bedingungen erfüllt waren) — keine Blackbox. */
  reasons: string[];
};

function passCompare(value: number | null, cmp: Compare | undefined): boolean {
  if (!cmp) return true;
  if (value === null) return false; // ehrlich: fehlende Daten erfüllen keine Bedingung
  if (cmp.gt !== undefined && !(value > cmp.gt)) return false;
  if (cmp.lt !== undefined && !(value < cmp.lt)) return false;
  return true;
}

/**
 * Einstiegs-Entscheidung: ALLE konfigurierten Bedingungen müssen erfüllt sein
 * (UND-Verknüpfung). Bei Erfolg werden Entry (= aktueller Preis, Market),
 * Stop-Loss und Take-Profit aus den Exit-Prozenten abgeleitet.
 */
export function evaluateSubAgentEntry(spec: SubAgentSpec, s: SubAgentSnapshot): SubAgentEntryDecision | null {
  const reasons: string[] = [];
  const e = spec.entryRules;

  if (e.price) {
    if (e.price.changePct24h) {
      if (!passCompare(s.changePct24h, e.price.changePct24h)) return null;
      reasons.push(`24h-Änderung ${s.changePct24h?.toFixed(2)} % erfüllt`);
    }
    if (e.price.dipFromHighPct !== undefined) {
      if (s.recentHigh === null || s.recentHigh <= 0) return null;
      const dipPct = ((s.recentHigh - s.price) / s.recentHigh) * 100;
      if (!(dipPct >= e.price.dipFromHighPct)) return null;
      reasons.push(`Dip ${dipPct.toFixed(2)} % vom Hoch (≥ ${e.price.dipFromHighPct} %)`);
    }
  }

  if (e.macro) {
    if (e.macro.vix) {
      if (!passCompare(s.vix, e.macro.vix)) return null;
      reasons.push(`VIX ${s.vix?.toFixed(1)}`);
    }
    if (e.macro.grsLabel) {
      if (s.grsLabel === null || s.grsLabel !== e.macro.grsLabel) return null;
      reasons.push(`Regime ${s.grsLabel}`);
    }
    if (e.macro.dxyChangePct20d) {
      if (!passCompare(s.dxyChangePct20d, e.macro.dxyChangePct20d)) return null;
      reasons.push(`DXY-20T ${s.dxyChangePct20d?.toFixed(2)} %`);
    }
  }

  if (e.funding?.rate) {
    if (!passCompare(s.fundingRate, e.funding.rate)) return null;
    reasons.push(`Funding ${s.fundingRate}`);
  }

  if (e.calendar) {
    if (e.calendar.noHighImpactWithinMin !== undefined) {
      // Blockiert, wenn ein Event innerhalb des Fensters liegt.
      if (s.minutesToNextHighImpact !== null && s.minutesToNextHighImpact <= e.calendar.noHighImpactWithinMin) return null;
      reasons.push(`kein High-Impact-Event in ${e.calendar.noHighImpactWithinMin} min`);
    }
    if (e.calendar.highImpactWithinMin !== undefined) {
      if (s.minutesToNextHighImpact === null || s.minutesToNextHighImpact > e.calendar.highImpactWithinMin) return null;
      reasons.push(`High-Impact-Event in ${s.minutesToNextHighImpact} min`);
    }
  }

  if (e.news?.anyKeyword) {
    const within = e.news.withinMin;
    const hit = s.recentNews.some(
      (n) => n.ageMin <= within && e.news!.anyKeyword!.some((kw) => n.title.toLowerCase().includes(kw.toLowerCase())),
    );
    if (!hit) return null;
    reasons.push('News-Keyword erkannt');
  }

  // Level aus den Exit-Prozenten (Market-Entry am aktuellen Preis).
  const entry = s.price;
  const slPct = spec.exitRules.stopLossPct / 100;
  const tpPct = spec.exitRules.takeProfitPct / 100;
  const stopLoss = spec.side === 'long' ? entry * (1 - slPct) : entry * (1 + slPct);
  const takeProfit = spec.side === 'long' ? entry * (1 + tpPct) : entry * (1 - tpPct);

  return { direction: spec.side, setupType: spec.setupType, entry, stopLoss, takeProfits: [takeProfit], reasons };
}

export type SubAgentPositionView = { openedAt: Date; direction: 'long' | 'short'; entryPrice: number };
export type SubAgentExitDecision = { reason: string } | null;

/**
 * Agenten-verwaltete Ausstiege, die die statischen TP/SL-Schutz-Orders NICHT
 * abdecken: zeitbasiert (maxHoldHours) und ereignisbasiert (Ausstiegs-News).
 * TP%/SL% selbst werden vom Order-Lifecycle/PositionMonitor gefüllt.
 */
export function evaluateSubAgentExit(
  spec: SubAgentSpec,
  pos: SubAgentPositionView,
  s: SubAgentSnapshot,
): SubAgentExitDecision {
  const x = spec.exitRules;
  if (x.maxHoldHours !== undefined) {
    const hoursHeld = (s.now.getTime() - pos.openedAt.getTime()) / 3_600_000;
    if (hoursHeld >= x.maxHoldHours) return { reason: `Zeit-Exit nach ${hoursHeld.toFixed(1)} h (≥ ${x.maxHoldHours} h)` };
  }
  if (x.exitOnNewsKeyword) {
    const hit = s.recentNews.find((n) => x.exitOnNewsKeyword!.some((kw) => n.title.toLowerCase().includes(kw.toLowerCase())));
    if (hit) return { reason: `News-Exit: „${hit.title.slice(0, 80)}"` };
  }
  return null;
}

/**
 * Baut den Preis-Teil eines Snapshots aus reinen Kerzen (für Backtest und für
 * den Live-Runner, wo Makro/News getrennt ergänzt werden). Deterministisch,
 * look-ahead-frei: sieht nur Kerzen bis `i`.
 */
export function priceSnapshotFromCandles(
  candles: Candle[],
  i: number,
  opts: { dipLookback: number; changeLookback: number },
): { price: number; recentHigh: number | null; changePct24h: number | null } {
  const cur = candles[i];
  if (!cur) return { price: 0, recentHigh: null, changePct24h: null };
  const price = cur.close;

  const dipStart = Math.max(0, i - opts.dipLookback + 1);
  let recentHigh: number | null = null;
  if (i - dipStart + 1 >= 2) {
    recentHigh = -Infinity;
    for (let k = dipStart; k <= i; k++) recentHigh = Math.max(recentHigh, candles[k]!.high);
  }

  let changePct24h: number | null = null;
  const refIdx = i - opts.changeLookback;
  const ref = candles[refIdx];
  if (ref && ref.close > 0) changePct24h = ((price - ref.close) / ref.close) * 100;

  return { price, recentHigh, changePct24h };
}
