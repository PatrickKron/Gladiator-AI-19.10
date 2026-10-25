/**
 * Korrelation von Tagesrenditen (Heatmap › Korrelation) — rein, ohne DB/Netz, getestet.
 *
 * Methode (ehrlich, look-ahead-frei):
 *  1. Je Reihe ein Schlusskurs pro Kalendertag (UTC-Datum des Kerzen-Zeitstempels), nur
 *     ABGESCHLOSSENE Tageskerzen (ts + 1 Tag ≤ jetzt) — die laufende Tageskerze nie.
 *  2. Je PAAR nur Tage, an denen beide Reihen einen Schlusskurs haben (paarweise vollständig):
 *     Krypto handelt 24/7, Börsen nicht. Die Rendite läuft über aufeinanderfolgende gemeinsame
 *     Tage — Fr→Mo deckt bei Krypto das Wochenende ab, genau wie bei der Aktie.
 *  3. Log-Renditen ln(c_t / c_{t-1}), Pearson. Weniger gemeinsame Renditen als `minReturns`
 *     → null („zu wenig gemeinsame Daten"), nie ein geschätzter Wert.
 */

const DAY_MS = 86_400_000;

/** Schlusskurs je Kalendertag ('YYYY-MM-DD' → close), aufsteigend. */
export type DailyCloses = Map<string, number>;

export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Tageskerzen → ein Schlusskurs je UTC-Tag. Laufende Kerzen (ts + 1 Tag > jetzt), nicht
 * endliche oder nicht positive Schlusskurse fallen weg; mehrere Kerzen am selben Tag →
 * die mit dem späteren Zeitstempel gewinnt.
 */
export function dailyCloses(candles: readonly { ts: Date | number; close: number }[], nowMs: number): DailyCloses {
  const best = new Map<string, { t: number; close: number }>();
  for (const c of candles) {
    const t = typeof c.ts === 'number' ? c.ts : c.ts.getTime();
    if (!Number.isFinite(t) || t + DAY_MS > nowMs) continue;
    if (!Number.isFinite(c.close) || c.close <= 0) continue;
    const key = utcDateKey(t);
    const prev = best.get(key);
    if (!prev || t >= prev.t) best.set(key, { t, close: c.close });
  }
  return new Map([...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, v.close]));
}

/** Gemeinsame Tage beider Reihen (aufsteigend) mit den jeweiligen Schlusskursen. */
export function alignPairwise(a: DailyCloses, b: DailyCloses): { dates: string[]; a: number[]; b: number[] } {
  const dates = [...a.keys()].filter((k) => b.has(k)).sort();
  return { dates, a: dates.map((k) => a.get(k)!), b: dates.map((k) => b.get(k)!) };
}

/** Log-Renditen ln(c_t / c_{t-1}). */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i]! / closes[i - 1]!));
  return out;
}

/**
 * Pearson-Korrelation. null bei weniger als 2 Werten, ungleicher Länge oder einer
 * Reihe ohne Varianz (dann ist r mathematisch nicht definiert).
 */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

/**
 * Renditen eines Paares über aufeinanderfolgende gemeinsame Tage. Mit `fromDate` nur
 * Renditen, deren Enddatum im Fenster liegt (der Basiskurs davor darf außerhalb liegen).
 */
export function pairReturns(a: DailyCloses, b: DailyCloses, fromDate?: string): { dates: string[]; x: number[]; y: number[] } {
  const al = alignPairwise(a, b);
  const rx = logReturns(al.a);
  const ry = logReturns(al.b);
  const dates: string[] = [];
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < rx.length; i++) {
    const end = al.dates[i + 1]!;
    if (fromDate !== undefined && end < fromDate) continue;
    dates.push(end);
    x.push(rx[i]!);
    y.push(ry[i]!);
  }
  return { dates, x, y };
}

export type CorrelationOptions = { minReturns: number; fromDate?: string };

/** r eines Paares + Anzahl gemeinsamer Renditen; r = null unter `minReturns`. */
export function pairCorrelation(a: DailyCloses, b: DailyCloses, opts: CorrelationOptions): { r: number | null; n: number } {
  const { x, y } = pairReturns(a, b, opts.fromDate);
  return { r: x.length >= opts.minReturns ? pearson(x, y) : null, n: x.length };
}

/**
 * Korrelationsmatrix (symmetrisch). Diagonale: 1, wenn die Reihe selbst genug Renditen im
 * Fenster hat, sonst null; `n` = gemeinsame Renditen je Paar (Diagonale = eigene).
 */
export function correlationMatrix(series: readonly DailyCloses[], opts: CorrelationOptions): { r: (number | null)[][]; n: number[][] } {
  const k = series.length;
  const r: (number | null)[][] = Array.from({ length: k }, () => new Array<number | null>(k).fill(null));
  const n: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      if (i === j) {
        const own = pairReturns(series[i]!, series[i]!, opts.fromDate).x.length;
        n[i]![i] = own;
        r[i]![i] = own >= opts.minReturns ? 1 : null;
        continue;
      }
      const pc = pairCorrelation(series[i]!, series[j]!, opts);
      r[i]![j] = pc.r;
      r[j]![i] = pc.r;
      n[i]![j] = pc.n;
      n[j]![i] = pc.n;
    }
  }
  return { r, n };
}
