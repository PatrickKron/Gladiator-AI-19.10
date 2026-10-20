/**
 * Reentry-Plan / Hebel-Vorschlag / Auto-Kill-Grund (05_ §9) als kompakte
 * Chips für die Signal-Karte. Rein (testbar) — liefert nur i18n-Keys und
 * Parameter; Texte stehen in allen 5 Katalogen.
 */

export type ReentryInfo = {
  enabled: boolean;
  minPullbackPct: number;
  maxPullbackPct: number;
  zoneLow?: number;
  zoneHigh?: number;
  maxReentries?: number;
  generation?: number;
  parentSignalId?: string;
  rootSignalId?: string;
};

export type LeverageUpgradeInfo = {
  triggerPct: number;
  maxLeverage: number;
  multiplier?: number;
  suggestion?: { suggested: number; from: number; movePct: number; reason: string; at: string; positionId: string; price: number };
};

export type AutoKillInfo = { reason: string; score: number | null; rescored: number | null; at: string };

export type LifecycleChip = {
  key: string;
  params: Record<string, string | number>;
  hintKey: string;
  hintParams: Record<string, string | number>;
  tone: 'info' | 'warn' | 'neg' | 'mut';
  /** Nur bei Auto-Kill: Key des übersetzten Grundes (wird in params.reason eingesetzt). */
  reasonKey?: string;
};

const KILL_REASON_KEY: Record<string, string> = {
  stop_breached: 'signals.lcKillStop',
  structure_broken: 'signals.lcKillStructure',
  score_below_threshold: 'signals.lcKillScore',
};

/** Live-Kursformat wie auf der Karte (≥ 1000 ohne Nachkommastellen). */
function round(n: number): number {
  return n >= 1000 ? Math.round(n) : Math.round(n * 100) / 100;
}

export function lifecycleChips(s: {
  status: string;
  reentry: ReentryInfo | null | undefined;
  leverageUpgrade: LeverageUpgradeInfo | null | undefined;
  autoKill: AutoKillInfo | null | undefined;
}): LifecycleChip[] {
  // Entwertetes Signal: nur der Grund zählt — Pläne sind gegenstandslos.
  if (s.autoKill) {
    return [
      {
        key: 'signals.lcKilled',
        reasonKey: KILL_REASON_KEY[s.autoKill.reason] ?? 'signals.lcKillOther',
        params: { from: s.autoKill.score ?? '—', to: s.autoKill.rescored ?? '—' },
        hintKey: 'signals.lcKilledHint',
        hintParams: {},
        tone: 'neg',
      },
    ];
  }

  const chips: LifecycleChip[] = [];
  const live = s.status === 'new' || s.status === 'confirmed' || s.status === 'filled';
  const re = s.reentry;
  if (re && (re.generation ?? 0) > 0) {
    chips.push({
      key: 'signals.lcReentryChild',
      params: { n: re.generation ?? 1 },
      hintKey: 'signals.lcReentryChildHint',
      hintParams: {},
      tone: 'info',
    });
  } else if (re && live) {
    if (re.enabled && re.zoneLow !== undefined && re.zoneHigh !== undefined) {
      chips.push({
        key: 'signals.lcReentryZone',
        params: { low: round(re.zoneLow), high: round(re.zoneHigh) },
        hintKey: 'signals.lcReentryHint',
        hintParams: { min: re.minPullbackPct, max: re.maxPullbackPct },
        tone: 'info',
      });
    } else if (!re.enabled) {
      chips.push({ key: 'signals.lcReentryOff', params: {}, hintKey: 'signals.lcReentryOffHint', hintParams: {}, tone: 'mut' });
    }
  }

  const lu = s.leverageUpgrade;
  if (lu?.suggestion) {
    chips.push({
      key: 'signals.lcLeverageSuggestion',
      params: { from: lu.suggestion.from, to: lu.suggestion.suggested },
      hintKey: 'signals.lcLeverageSuggestionHint',
      hintParams: { move: lu.suggestion.movePct },
      tone: 'warn',
    });
  } else if (lu && live && lu.multiplier !== undefined) {
    chips.push({
      key: 'signals.lcLeverageTrigger',
      params: { pct: lu.triggerPct },
      hintKey: 'signals.lcLeverageTriggerHint',
      hintParams: { pct: lu.triggerPct, mult: lu.multiplier, max: lu.maxLeverage },
      tone: 'mut',
    });
  }
  return chips;
}
