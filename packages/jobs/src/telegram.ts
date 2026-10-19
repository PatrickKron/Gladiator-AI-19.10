/**
 * Telegram-Ausspielung (11_ Phase 7): Signal-Alerts, Kill-Switch-Warnungen,
 * Morning-Briefing. Ohne TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID ehrlich
 * deaktiviert — der ALTE kompromittierte Token (7544725601:…, 10_ §1) wird
 * aktiv VERWEIGERT: Patrick muss via BotFather einen neuen Bot anlegen.
 * Versand-Fehler werden geloggt, crashen aber nie den Handelspfad.
 */

/** Prefix des kompromittierten Alt-Tokens aus v1 (10_ §1) — niemals akzeptieren. */
const COMPROMISED_TOKEN_PREFIX = '7544725601:';

export function telegramConfigured(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  if (token.startsWith(COMPROMISED_TOKEN_PREFIX)) {
    console.error('[telegram] VERWEIGERT: TELEGRAM_BOT_TOKEN ist der kompromittierte v1-Token (10_ §1) — bitte via BotFather neu anlegen.');
    return false;
  }
  return true;
}

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Sendet eine HTML-Nachricht. Nicht konfiguriert ⇒ false (ehrlich, still). */
export async function sendTelegram(text: string): Promise<boolean> {
  if (!telegramConfigured()) return false;
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.error(`[telegram] sendMessage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[telegram] Versand fehlgeschlagen:', String(err));
    return false;
  }
}

// ── Pure Formatter (TDD) ──────────────────────────────────────────────────

export type SignalAlertData = {
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  setupType: string;
  source: string;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  score: number;
  portfolioVote: 'confirm' | 'reject' | 'caution' | null;
  portfolioConfidence: number | null;
  disabledAgents: string[];
};

const VOTE_ICON: Record<string, string> = { confirm: '✅', caution: '🟡', reject: '⛔' };

function fmt(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: n >= 1000 ? 0 : 4 });
}

export function formatSignalAlert(s: SignalAlertData): string {
  const dir = s.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const vote = s.portfolioVote
    ? `${VOTE_ICON[s.portfolioVote] ?? ''} Schwarm: <b>${s.portfolioVote}</b>${
        s.portfolioConfidence !== null ? ` (${Math.round(s.portfolioConfidence * 100)} %)` : ''
      }`
    : 'Schwarm-Review ausstehend';
  const disabled = s.disabledAgents.length > 0 ? `\n<i>Deaktiviert: ${escapeHtml(s.disabledAgents.join(', '))}</i>` : '';
  return [
    `${dir} <b>${escapeHtml(s.symbol)}</b> · ${escapeHtml(s.timeframe)} · ${escapeHtml(s.setupType)} (${escapeHtml(s.source)})`,
    `Score <b>${s.score.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</b>/10`,
    `Entry <code>${fmt(s.entry)}</code> · SL <code>${fmt(s.stopLoss)}</code> · TP ${s.takeProfits.map(fmt).join(' / ')}`,
    vote + disabled,
    '→ Bestätigen/Ablehnen in der App (Mensch im Loop).',
  ].join('\n');
}

export function formatKillSwitchAlert(active: boolean, actor: string): string {
  return active
    ? `🛑 <b>KILL-SWITCH AKTIVIERT</b> von ${escapeHtml(actor)} — keine neuen Orders. Bestehende Schutz-Orders laufen weiter.`
    : `🟢 Kill-Switch deaktiviert von ${escapeHtml(actor)} — Orders durchlaufen wieder das normale Risk-Gate.`;
}

/** Notfall-Alarm (Stop nicht platzierbar → Glattstellung / UNGESCHÜTZT). */
export function formatEmergencyAlert(symbol: string, detail: string, closed: boolean): string {
  return closed
    ? `🚨 <b>Notfall-Glattstellung ${escapeHtml(symbol)}</b>\n${escapeHtml(detail)}\nKill-Switch ist aktiv — erst nach Prüfung wieder freigeben.`
    : `🆘 <b>UNGESCHÜTZTE POSITION ${escapeHtml(symbol)}</b>\n${escapeHtml(detail)}\nSofort an der Börse prüfen! Kill-Switch ist aktiv.`;
}

