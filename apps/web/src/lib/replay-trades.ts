/**
 * Übungs-Trades im Bar-Replay (Repo-Masterliste, Phase 3): reine Hilfen für die
 * Chart-Seite. Der Ausgang jedes Trades kommt vom Server (market.replayTrade —
 * dieselbe Engine wie Backtest und „Was wäre passiert"); hier nur Level aus
 * Prozent-Vorgaben und die Zusammenfassung einer Replay-Sitzung. Nichts wird gespeichert.
 */

export type ReplayDirection = 'long' | 'short';
export type ReplayTradeStatus = 'open' | 'closed' | 'invalid';

export type ReplayTrade = {
  id: string;
  direction: ReplayDirection;
  /** Open-Zeit (Sekunden) der Replay-Kerze beim Klick — Einstieg zu ihrem Schluss. */
  entryTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  status: ReplayTradeStatus;
  /** Netto-R (bei offen: Zwischenstand auf den letzten Close), null ohne Folge-Kerze. */
  rMultiple: number | null;
  exitReason: 'tp' | 'sl' | 'be' | 'trail' | 'manual' | null;
  exitTime: number | null;
};

export type ReplaySummary = { total: number; closed: number; open: number; wins: number; sumR: number; winRate: number | null };

/** Stop und Ziel aus Prozent vom Einstieg — Long unter/über, Short über/unter. */
export function replayLevels(entry: number, direction: ReplayDirection, slPct: number, tpPct: number): { stopLoss: number; takeProfit: number } {
  const sl = Math.max(0.01, slPct) / 100;
  const tp = Math.max(0.01, tpPct) / 100;
  return direction === 'long' ? { stopLoss: entry * (1 - sl), takeProfit: entry * (1 + tp) } : { stopLoss: entry * (1 + sl), takeProfit: entry * (1 - tp) };
}

/** Zusammenfassung: nur geschlossene Trades zählen fürs Ergebnis; offene werden gezählt, nicht bewertet. */
export function summarizeReplayTrades(trades: readonly ReplayTrade[]): ReplaySummary {
  const valid = trades.filter((t) => t.status !== 'invalid');
  const closed = valid.filter((t) => t.status === 'closed' && t.rMultiple !== null);
  const wins = closed.filter((t) => t.rMultiple! > 0).length;
  const sumR = closed.reduce((acc, t) => acc + t.rMultiple!, 0);
  return {
    total: valid.length,
    closed: closed.length,
    open: valid.filter((t) => t.status === 'open').length,
    wins,
    sumR: Math.round(sumR * 100) / 100,
    winRate: closed.length > 0 ? wins / closed.length : null,
  };
}
