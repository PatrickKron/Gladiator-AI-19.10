/**
 * GRS — Global Risk Score (Aegis, 09_ §3.8).
 * Deterministische, DOKUMENTIERTE Formel aus echten Marktdaten:
 *
 *   Komponenten (je 0..100, stückweise linear interpoliert):
 *   - VIX-Level:            12 → 10 · 16 → 30 · 20 → 50 · 28 → 75 · 40 → 95
 *   - DXY 20-Tage-Änderung: −2 % → 20 · 0 % → 40 · +1.5 % → 65 · +3 % → 90
 *     (steigender Dollar = Liquiditätsentzug = risk-off)
 *   - US10Y 20-Tage-Änderung in bp: −30 → 25 · 0 → 40 · +25 → 65 · +50 → 90
 *     (schnell steigende Renditen = Druck auf Risiko-Assets)
 *
 *   GRS = 0.5·VIX + 0.25·DXY + 0.25·US10Y   (Label: <35 risk-on, ≥65 risk-off)
 *
 * Kein Zufall, keine Magie: gleiche Inputs ⇒ gleicher Score. Kalibrierung
 * der Stützstellen ist bewusst konservativ und im Labor nachjustierbar.
 */

export type MacroPoint = { ts: Date; value: number };

export type GrsInputs = {
  vix: number;
  dxyChangePct20d: number;
  us10yChangeBp20d: number;
};

export type GrsComponent = { score: number; input: number };

export type Grs = {
  score: number;
  label: 'risk-on' | 'neutral' | 'risk-off';
  components: { vix: GrsComponent; dxy: GrsComponent; us10y: GrsComponent };
  inputs: GrsInputs;
};

/** Stückweise lineare Interpolation über (x, y)-Stützstellen; außerhalb geclamped. */
function piecewise(x: number, points: [number, number][]): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

const VIX_CURVE: [number, number][] = [
  [12, 10],
  [16, 30],
  [20, 50],
  [28, 75],
  [40, 95],
];
const DXY_CURVE: [number, number][] = [
  [-2, 20],
  [0, 40],
  [1.5, 65],
  [3, 90],
];
const US10Y_CURVE: [number, number][] = [
  [-30, 25],
  [0, 40],
  [25, 65],
  [50, 90],
];

export function computeGrs(inputs: GrsInputs): Grs {
  const vix = { score: piecewise(inputs.vix, VIX_CURVE), input: inputs.vix };
  const dxy = { score: piecewise(inputs.dxyChangePct20d, DXY_CURVE), input: inputs.dxyChangePct20d };
  const us10y = { score: piecewise(inputs.us10yChangeBp20d, US10Y_CURVE), input: inputs.us10yChangeBp20d };
  const score = Math.min(100, Math.max(0, vix.score * 0.5 + dxy.score * 0.25 + us10y.score * 0.25));
  return {
    score,
    label: score < 35 ? 'risk-on' : score >= 65 ? 'risk-off' : 'neutral',
    components: { vix, dxy, us10y },
    inputs,
  };
}

const LOOKBACK_POINTS = 20;

/**
 * Leitet die GRS-Inputs aus echten Tages-Serien ab (jeweils aufsteigend
 * sortiert; letzter Punkt = aktuell, Vergleichspunkt = 20 Handelstage davor).
 * Zu wenig Historie ⇒ ehrlich null.
 */
export function deriveGrsFromSeries(vix: MacroPoint[], dxy: MacroPoint[], us10y: MacroPoint[]): Grs | null {
  if (vix.length < 1 || dxy.length < LOOKBACK_POINTS + 1 || us10y.length < LOOKBACK_POINTS + 1) return null;
  const last = (s: MacroPoint[]) => s[s.length - 1]!.value;
  const ago = (s: MacroPoint[]) => s[s.length - 1 - LOOKBACK_POINTS]!.value;

  const dxyChangePct20d = (last(dxy) / ago(dxy) - 1) * 100;
  // ^TNX notiert in Prozentpunkten (4.24 = 4,24 %): Differenz × 100 = Basispunkte.
  const us10yChangeBp20d = (last(us10y) - ago(us10y)) * 100;

  return computeGrs({ vix: last(vix), dxyChangePct20d, us10yChangeBp20d });
}

/**
 * GRS-Verlauf der letzten `days` Handelstage (P2.11): rechnet den Score je Tag
 * mit derselben Ableitung wie aktuell — kein Fake, gleiche Formel, nur „as of"
 * je Stichtag. Aufsteigend nach Zeit; Tage ohne ausreichende Historie entfallen.
 */
export function grsHistory(vix: MacroPoint[], dxy: MacroPoint[], us10y: MacroPoint[], days = 30): { ts: Date; score: number }[] {
  const out: { ts: Date; score: number }[] = [];
  const maxK = Math.min(vix.length, dxy.length, us10y.length);
  for (let k = 0; k < Math.min(days, maxK); k++) {
    const endVix = vix.length - k;
    const g = deriveGrsFromSeries(vix.slice(0, endVix), dxy.slice(0, dxy.length - k), us10y.slice(0, us10y.length - k));
    if (g) out.push({ ts: vix[endVix - 1]!.ts, score: g.score });
  }
  return out.reverse();
}
