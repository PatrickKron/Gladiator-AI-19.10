/**
 * SAFE-Kill-Switch-Schwellen (10_ §5a/§5b) + reine Hilfsfunktionen, mit denen
 * der Executor seine ECHTEN Rohdaten (Kerzen, Regime-Historie, Fills) in die
 * Eingaben der Risk-Engine übersetzt. Keine I/O, deterministisch, getestet.
 *
 * Wo der Blueprint Zahlen nennt, gelten genau diese. Auslegungen (wo der
 * Blueprint nur das Ziel nennt) sind je Konstante dokumentiert.
 */

/** SAFE-003 (10_ §5a): BTC-Intraday > 10 % ⇒ keine neuen Positionen. */
export const SAFE_003_BTC_INTRADAY_MAX_PCT = 10;
/** SAFE-003 (10_ §5a): ETH-Intraday > 15 % ⇒ keine neuen Positionen. */
export const SAFE_003_ETH_INTRADAY_MAX_PCT = 15;

/**
 * SAFE-004 (10_ §5a): Pipeline-Latenz > 5 s ⇒ Execution pausieren.
 * Gemessen wird die Live-Preis-Abfrage an der Venue unmittelbar vor der Order
 * (der letzte, zeitkritische Pipeline-Schritt vor dem Senden).
 */
export const SAFE_004_MAX_LATENCY_MS = 5_000;

/**
 * SAFE-005 (10_ §5a): Daten stale > 5 min. Kerzen werden nicht sekündlich,
 * sondern im Scan-Takt nachgeladen — „stale" heißt daher: älter als das
 * erwartete Höchstalter der Pipeline (vom Aufrufer geliefert) PLUS 5 min.
 */
export const SAFE_005_STALE_TOLERANCE_MS = 5 * 60_000;
/** SAFE-005 (10_ §5a): Preis-Z-Score > 5 ⇒ Datenfehler/Ausreißer. */
export const SAFE_005_MAX_ZSCORE = 5;
/** Mindestanzahl Renditen für einen belastbaren Z-Score (Auslegung, konservativ). */
export const SAFE_005_MIN_RETURNS = 20;

/** SAFE-006 (10_ §5a): Slippage > 1 % einzeln ⇒ nur Limit-Orders. */
export const SAFE_006_MAX_SINGLE_SLIPPAGE_PCT = 1;
/** SAFE-006 (10_ §5a): Slippage > 0,3 % im Schnitt ⇒ nur Limit-Orders. */
export const SAFE_006_MAX_AVG_SLIPPAGE_PCT = 0.3;
/**
 * Betrachtungsfenster der Slippage-Historie (Auslegung): 24 h. Ein festes
 * Zeitfenster statt „letzte N Fills", sonst sperrt ein schlechter Fill den
 * Market-Pfad für immer (ohne neue Fills ändert sich die Historie nie).
 */
export const SAFE_006_WINDOW_MS = 24 * 3_600_000;

/** SAFE-007 (10_ §5a): > 3 Regime-Wechsel in 24 h ⇒ Size −75 %. */
export const SAFE_007_MAX_REGIME_CHANGES_24H = 3;
export const SAFE_007_SIZE_FACTOR = 0.25;

/** SAFE-008 (10_ §5b, MiFID II RTS 6): Price-Collar 2 % (Entry vs. Live-Mark). */
export const SAFE_008_PRICE_COLLAR_PCT = 2;
/**
 * SAFE-008 (10_ §5b): max. 10 Orders/min. Gezählt werden risiko-eröffnende
 * Orders (nicht reduce-only); Schutz-Orders (SL/TP) eines Trades werden nie
 * gedrosselt — eine Position darf nie ungeschützt bleiben (06_ §5).
 */
export const SAFE_008_MAX_ORDERS_PER_MIN = 10;

/** SAFE-010 (10_ §5b, MAR): Opposite-Trade-Cooldown 5 min. */
export const SAFE_010_OPPOSITE_COOLDOWN_MS = 5 * 60_000;
/** SAFE-010 (10_ §5b, MAR): max. 3 offene (nicht reduce-only) Orders je Asset. */
export const SAFE_010_MAX_OPEN_ORDERS_PER_ASSET = 3;

export type OhlcLike = { open: number; high: number; low: number; close: number };

/**
 * SAFE-003: größte Auslenkung (in %) vom Tages-Open — nach oben ODER unten.
 * Eingabe: chronologische Kerzen ab UTC-Tagesbeginn. Leer ⇒ null (Daten fehlen).
 */
export function intradayMovePct(candles: OhlcLike[]): number | null {
  if (candles.length === 0) return null;
  const open = candles[0]!.open;
  if (!(open > 0)) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return Math.max((high - open) / open, (open - low) / open) * 100;
}

/**
 * SAFE-005: Z-Score der aktuellen Rendite (Live-Mark vs. letzter Close)
 * relativ zur Streuung der Kerzen-Log-Renditen. Zu wenig Historie oder
 * σ = 0 ⇒ null (ehrlich, keine Fantasiezahl).
 */
export function returnZScore(markPrice: number, closes: number[]): number | null {
  if (!(markPrice > 0) || closes.length < SAFE_005_MIN_RETURNS + 1) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (!(a > 0) || !(b > 0)) return null;
    rets.push(Math.log(b / a));
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  const current = Math.log(markPrice / closes[closes.length - 1]!);
  return (current - mean) / sd;
}

/** SAFE-007: Anzahl Regime-Übergänge in einer chronologischen Folge. */
export function countRegimeChanges(regimes: string[]): number {
  let n = 0;
  for (let i = 1; i < regimes.length; i++) if (regimes[i] !== regimes[i - 1]) n++;
  return n;
}

/** Timeframe-String (`15m`, `4h`, `1d`, `1w`, `1M`) → Millisekunden; unbekannt ⇒ null. */
export function timeframeToMs(tf: string): number | null {
  const m = /^(\d+)(m|h|d|w|M)$/.exec(tf);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 30 * 86_400_000 }[m[2] as 'm' | 'h' | 'd' | 'w' | 'M'];
  return n * unit;
}
