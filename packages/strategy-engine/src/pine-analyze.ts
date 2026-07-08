/**
 * Regelbasierte Struktur-Analyse von TradingView-Pine-Scripts (07_ §5).
 *
 * BEWUSST kein Pine-Interpreter: Wir extrahieren nur belegbare Fakten aus dem
 * Quelltext (Version, Skript-Typ, Inputs, Indikatoren, Entry/Exit-Aufrufe,
 * SL/TP-Handling, Alerts, Repaint-Risiken). Alles Weitere (Logik-Erklärung,
 * Verbesserungen) übernimmt — falls konfiguriert — das LLM im Router.
 * Kein Fake: Was wir nicht sicher erkennen, bleibt null/leer statt geraten.
 */

export type PineInput = {
  name: string;
  kind: string; // int, float, bool, string, timeframe, source, ... oder 'legacy'
  defval: string | null;
};

export type PineAnalysis = {
  version: number | null;
  scriptType: 'strategy' | 'indicator' | 'unknown';
  title: string | null;
  inputs: PineInput[];
  indicators: string[]; // dedupte ta.*-Aufrufe, z. B. ["ema", "rsi", "atr"]
  entryCalls: string[]; // strategy.entry(...)-Zeilen (gekürzt)
  exitCalls: string[]; // strategy.exit/close/close_all(...)-Zeilen (gekürzt)
  hasStopLoss: boolean;
  hasTakeProfit: boolean;
  alertCount: number;
  securityTimeframes: string[]; // request.security-Timeframe-Argumente (best effort)
  warnings: string[]; // ehrliche Heuristiken, als solche formuliert
  lineCount: number;
};

/** Kommentar am Zeilenende entfernen — quote-bewusst (kein // innerhalb von Strings). */
function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '/' && line[i + 1] === '/' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function excerpt(line: string, max = 140): string {
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

export function analyzePineScript(code: string): PineAnalysis {
  const rawLines = code.split(/\r?\n/);

  // Version steht in einem Kommentar → VOR dem Kommentar-Strip lesen.
  let version: number | null = null;
  for (const line of rawLines) {
    const m = line.match(/\/\/@version\s*=\s*(\d+)/);
    if (m) {
      version = Number(m[1]);
      break;
    }
  }

  const lines = rawLines.map(stripLineComment);
  const clean = lines.join('\n');

  // Skript-Typ + Titel aus der Deklaration.
  let scriptType: PineAnalysis['scriptType'] = 'unknown';
  let title: string | null = null;
  const decl = clean.match(/^\s*(strategy|indicator|study)\s*\(\s*(?:title\s*=\s*)?(["'])((?:(?!\2).)*)\2/m);
  if (decl) {
    scriptType = decl[1] === 'strategy' ? 'strategy' : 'indicator';
    title = decl[3] ?? null;
  } else if (/^\s*strategy\s*\(/m.test(clean)) {
    scriptType = 'strategy';
  } else if (/^\s*(indicator|study)\s*\(/m.test(clean)) {
    scriptType = 'indicator';
  }

  // Inputs: name = input.kind(defval, ...) — v5-Form und Legacy input(...).
  const inputs: PineInput[] = [];
  const inputRe = /(\w+)\s*=\s*input(?:\.(\w+))?\s*\(\s*([^,)\n]*)/g;
  for (const m of clean.matchAll(inputRe)) {
    inputs.push({
      name: m[1]!,
      kind: m[2] ?? 'legacy',
      defval: m[3]?.trim() ? m[3]!.trim() : null,
    });
  }

  // Indikatoren: ta.*-Aufrufe, dedupt, in Auftrittsreihenfolge.
  const indicators: string[] = [];
  for (const m of clean.matchAll(/\bta\.(\w+)\s*\(/g)) {
    const name = m[1]!;
    if (!indicators.includes(name)) indicators.push(name);
  }

  // Entry/Exit-Aufrufe als Beleg-Zeilen.
  const entryCalls: string[] = [];
  const exitCalls: string[] = [];
  for (const line of lines) {
    if (/\bstrategy\.entry\s*\(/.test(line)) entryCalls.push(excerpt(line));
    if (/\bstrategy\.(exit|close|close_all)\s*\(/.test(line)) exitCalls.push(excerpt(line));
  }

  // SL/TP: stop=/loss= bzw. limit=/profit= in strategy.exit/order-Aufrufen.
  const exitJoined = lines.filter((l) => /\bstrategy\.(exit|order)\s*\(/.test(l)).join('\n');
  const hasStopLoss = /\b(stop|loss)\s*=/.test(exitJoined);
  const hasTakeProfit = /\b(limit|profit)\s*=/.test(exitJoined);

  // Alerts.
  const alertCount =
    (clean.match(/\balertcondition\s*\(/g)?.length ?? 0) + (clean.match(/\balert\s*\(/g)?.length ?? 0);

  // request.security-Timeframes (2. Argument), best effort.
  const securityTimeframes: string[] = [];
  for (const m of clean.matchAll(/\brequest\.security\s*\(\s*[^,]+,\s*(?:(["'])((?:(?!\1).)*)\1|([\w.]+))/g)) {
    const tf = m[2] ?? m[3] ?? '';
    if (tf && !securityTimeframes.includes(tf)) securityTimeframes.push(tf);
  }

  // ── Warnhinweise (Heuristik, ehrlich benannt) ──
  const warnings: string[] = [];
  if (version !== null && version < 5) {
    warnings.push(`Pine v${version} — veraltet; v5/v6 bietet request.security mit lookahead-Kontrolle und ta.*-Namespace.`);
  }
  if (/barmerge\.lookahead_on/.test(clean)) {
    warnings.push('lookahead_on gefunden — klassische Repaint-Falle: der Backtest sieht Zukunftsdaten, live nicht.');
  }
  if (/\brequest\.security\s*\(/.test(clean) && !/lookahead\s*=/.test(clean)) {
    warnings.push('request.security ohne explizites lookahead= — Standard ist ok (off), aber explizit ist sicherer gegen Repainting.');
  }
  if (/calc_on_every_tick\s*=\s*true/.test(clean)) {
    warnings.push('calc_on_every_tick=true — Intrabar-Ausführung: Backtest (Bar-Schluss) und Live-Verhalten weichen ab.');
  }
  if (/\bvarip\b/.test(clean)) {
    warnings.push('varip gefunden — Intrabar-Zustand, der im Backtest nicht reproduzierbar ist (Repaint-Risiko).');
  }
  if (scriptType === 'strategy' && entryCalls.length > 0 && !hasStopLoss) {
    warnings.push('Kein Stop-Loss erkannt (kein stop=/loss= in strategy.exit/order) — unbegrenztes Risiko pro Trade.');
  }
  if (scriptType === 'strategy' && entryCalls.length > 0 && !hasTakeProfit && !/\bstrategy\.(close|close_all)\s*\(/.test(clean)) {
    warnings.push('Kein Take-Profit und kein strategy.close erkannt — unklar, wie Gewinne realisiert werden.');
  }

  return {
    version,
    scriptType,
    title,
    inputs,
    indicators,
    entryCalls,
    exitCalls,
    hasStopLoss,
    hasTakeProfit,
    alertCount,
    securityTimeframes,
    warnings,
    lineCount: rawLines.length,
  };
}
