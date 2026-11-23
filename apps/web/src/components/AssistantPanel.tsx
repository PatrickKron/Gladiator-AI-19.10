import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { detectStrategyPatterns, type DslTimeframe } from '@gladiator/strategy-engine';
import { streamAssistant, trpc, type AssistantCard } from '../api.js';
import { getSelectedAsset, getSelectedVenue } from './AssetSelect.js';
import { ChatPatternStrategyCard, type PatternDraftData } from './ChatPatternStrategyCard.js';
import { loadTf } from '../lib/chart-tf.js';
import { parseChartHash } from '../lib/chart-url.js';
import { appLocale } from '../lib/locale.js';

/**
 * Gladiator-Chat (Patricks Mängelliste 2026-10-22, Punkt 4): EIN Dialog, überall erreichbar,
 * der in die App eingreift — Strategien entwerfen, backtesten, speichern, zur Nutzung
 * vorschlagen (Bestätigung durch den Nutzer), Markt screenen, Seiten öffnen. Jede Zahl in
 * einer Karte stammt aus einem echten Werkzeug-Lauf; ohne Anthropic-Schlüssel ehrlich
 * „nicht verbunden“ mit dem Weg zu den Einstellungen.
 */

type PatternOffer = { text: string; patterns: string[]; symbol: string; timeframe: DslTimeframe };
type Msg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: AssistantCard[];
  pending?: boolean;
  patternDraft?: PatternDraftData;
  patternOffer?: PatternOffer;
};
type Status = Awaited<ReturnType<typeof trpc.assistant.status.query>>;
type Conversation = Awaited<ReturnType<typeof trpc.assistant.conversations.query>>[number];

type LiveUiContext = {
  route: string;
  pageLabel: string;
  tab: string | null;
  symbol: string;
  venue: string;
  timeframe: DslTimeframe;
};

function readLiveUiContext(): LiveUiContext {
  const hash = window.location.hash || '#/';
  const [pathPart, queryPart] = hash.split('?');
  const qs = new URLSearchParams(queryPart ?? '');
  const parsedChart = parseChartHash(hash);
  const symbol = parsedChart.symbol ?? getSelectedAsset();
  const venue = parsedChart.venue ?? getSelectedVenue();
  const timeframe: DslTimeframe = parsedChart.tf ?? loadTf(symbol) ?? '1h';
  const tab = qs.get('tab');
  const pageMap: Record<string, string> = {
    '#/': 'Übersicht',
    '#/charts': 'Chart',
    '#/chart': 'Chart',
    '#/strategien': 'Strategien',
    '#/labor': 'Backtest-Labor',
    '#/marktlage': 'Marktlage',
    '#/traden': 'Traden',
    '#/signale': 'Signale',
    '#/screener': 'Screener',
    '#/agenten': 'Agenten',
    '#/vermoegen': 'Vermögen',
  };
  const pageLabel = pageMap[pathPart ?? '#/'] ?? (pathPart?.replace(/^#\//, '') || 'Übersicht');
  return { route: hash, pageLabel, tab, symbol, venue, timeframe };
}

const CONV_KEY = 'gladiator.chatConversation';
const TOOL_KEYS = [
  'app_overview',
  'propose_strategy',
  'analyze_script',
  'test_strategy_on_assets',
  'run_backtest',
  'save_version',
  'lab_backtest',
  'promote_version',
  'run_screen',
  'asset_analysis',
  'agents_status',
  'trading_settings',
  'update_trading_settings',
  'kill_switch',
  'demo_account',
  'recent_signals',
  'demo_order',
  'hedging_status',
  'update_hedging',
  'navigate',
] as const;

/** Erkennt Pine-Script-Code oder eine Beschreibung über Skripte/Strategien im Eingabefeld. */
export function looksLikeScriptOrStrategy(text: string): boolean {
  const s = text.trim();
  if (s.length < 12) return false;
  return /\/\/@version|\b(strategy|indicator|study)\s*\(|\bta\.(ema|sma|rsi|macd|atr|crossover|crossunder|supertrend|bb)\b|\bstrategy\.(entry|exit|close)\b|\b(pine\s*script|pine-skript|skript|script)\b/i.test(
    s,
  );
}

/** Öffnet den Chat von überall (z. B. Leer-Zustand im Workshop). */
export function openAssistant(prefill?: string): void {
  window.dispatchEvent(new CustomEvent('gladiator:chat', { detail: { prefill } }));
}

export function AssistantPanel({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: string | null }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CONV_KEY);
    } catch {
      return null;
    }
  });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uiCtx, setUiCtx] = useState<LiveUiContext>(() => readLiveUiContext());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const sync = () => setUiCtx(readLiveUiContext());
    if (open) sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [open]);

  const detectedPatterns = useMemo(() => detectStrategyPatterns(input), [input]);

  const loadConversations = useCallback(async () => {
    try {
      const rows = await trpc.assistant.conversations.query();
      setConversations(rows);
      return rows;
    } catch {
      return [] as Conversation[];
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const rows = await trpc.assistant.messages.query({ id });
      setMessages(rows.map((r) => ({ id: r.id, role: r.role, content: r.content, cards: r.cards })));
    } catch {
      setMessages([]);
      setConvId(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void trpc.assistant.status.query().then(setStatus).catch(() => setStatus({ configured: false, budgetUsd: 0, spentUsd: 0 }));
    void loadConversations().then((rows) => {
      const current = convId && rows.some((r) => r.id === convId) ? convId : (rows[0]?.id ?? null);
      setConvId(current);
      if (current) void loadMessages(current);
      else setMessages([]);
    });
    setTimeout(() => inputRef.current?.focus(), 50);
    // beim Öffnen einmal laden
  }, [open]);

  useEffect(() => {
    if (prefill) setInput(prefill);
  }, [prefill]);

  useEffect(() => {
    try {
      if (convId) localStorage.setItem(CONV_KEY, convId);
    } catch {
      /* nur Komfort */
    }
  }, [convId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, tool]);

  const ensureConversation = async (): Promise<string> => {
    if (convId) return convId;
    const c = await trpc.assistant.create.mutate();
    setConvId(c.id);
    void loadConversations();
    return c.id;
  };

  /** Proaktiver Muster→Strategie-Workflow direkt im Chat (funktioniert mit UND ohne ANTHROPIC_API_KEY). */
  const buildPatternStrategyInChat = async (rawText: string, overrideSym?: string, overrideTf?: DslTimeframe) => {
    const text = rawText.trim();
    if (!text || busy) return;
    const live = readLiveUiContext();
    setUiCtx(live);
    const targetSym = overrideSym ?? live.symbol;
    const targetTf = overrideTf ?? live.timeframe;
    setError(null);
    setInput('');
    setBusy(true);
    setTool('propose_strategy');
    const tmpId = `pat-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: `u-${tmpId}`, role: 'user', content: text, cards: [] },
      { id: tmpId, role: 'assistant', content: `Erstelle Strategie aus deinem Muster & teste netto auf ${targetSym} (${targetTf})…`, cards: [], pending: true },
    ]);
    try {
      const res = await trpc.workshop.createFromText.mutate({
        text,
        symbol: targetSym,
        timeframe: targetTf,
        autoBacktest: true,
        lookbackDays: 365,
      });
      const draftData: PatternDraftData = {
        sessionId: res.session.id,
        initialName: res.session.name,
        summary: res.summary,
        dsl: res.dsl,
        conditions: res.ruleSummary.conditions,
        stopLoss: res.ruleSummary.stopLoss,
        takeProfits: res.ruleSummary.takeProfits,
        backtest: res.backtest
          ? {
              symbol: res.backtest.symbol,
              timeframe: res.backtest.timeframe,
              candles: res.backtest.candles,
              metrics: res.backtest.metrics,
            }
          : null,
        backtestError: res.backtestError,
      };
      const replyText = res.backtest
        ? `Ich habe deine Muster-Strategie erstellt und über echte Kerzen auf ${res.backtest.symbol} (${res.backtest.timeframe}) netto gebacktestet. Gib ihr unten einen Namen, speichere sie, blende sie im Chart ein oder aktiviere sie nach dem 12-Monats-Gate für Paper-Signale:`
        : `Ich habe deine Muster-Strategie als validierten Entwurf angelegt (${res.summary}). Du kannst ihr direkt einen Namen geben, sie speichern oder im Labor testen:`;
      setMessages((m) =>
        m.map((x) =>
          x.id === tmpId
            ? { id: tmpId, role: 'assistant', content: replyText, cards: [], patternDraft: draftData }
            : x,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Strategie-Entwurf fehlgeschlagen.');
      setMessages((m) => m.filter((x) => x.id !== tmpId));
    } finally {
      setBusy(false);
      setTool(null);
    }
  };

  const send = async (text: string) => {
    const msg = text.trim();
    if (!msg || busy) return;
    const live = readLiveUiContext();
    setUiCtx(live);
    const patterns = detectStrategyPatterns(msg);

    // Ohne konfigurierten Anthropic-Key bleibt der proaktive Muster- & Strategie-Partner voll nutzbar!
    if (status?.configured === false) {
      setError(null);
      setInput('');
      const uid = `u-${Date.now()}`;
      const aid = `a-${Date.now() + 1}`;
      if (patterns.length > 0) {
        const labels = patterns.map((p) => p.label);
        setMessages((m) => [
          ...m,
          { id: uid, role: 'user', content: msg, cards: [] },
          {
            id: aid,
            role: 'assistant',
            content: `Ich habe in deiner Nachricht Muster erkannt (${labels.join(', ')}) — aktiv im Blick: ${live.symbol} (${live.timeframe}). Soll ich dir dazu direkt eine Strategie erstellen und netto backtesten?`,
            cards: [],
            patternOffer: { text: msg, patterns: labels, symbol: live.symbol, timeframe: live.timeframe },
          },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          { id: uid, role: 'user', content: msg, cards: [] },
          {
            id: aid,
            role: 'assistant',
            content: `Aktiver Kontext: ${live.symbol} (${live.timeframe}) auf „${live.pageLabel}“. Für freie KI-Gespräche hinterlege deinen Anthropic-Key unter Einstellungen → API-Keys. Sobald du hier ein Chartmuster oder Setup beschreibst (z. B. „RSI-Divergenz über EMA 200“, „Bollinger-Rebound“, „EMA 20/50 Crossover“), erstelle und teste ich dir die Strategie aber schon jetzt direkt im Chat!`,
            cards: [{ kind: 'link', label: 'Zu Einstellungen → API-Keys', hash: '#/einstellungen?tab=keys' }],
          },
        ]);
      }
      return;
    }

    setError(null);
    setInput('');
    setBusy(true);
    const tmpId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: `u-${tmpId}`, role: 'user', content: msg, cards: [] }, { id: tmpId, role: 'assistant', content: '', cards: [], pending: true }]);
    try {
      const id = await ensureConversation();
      const done = await streamAssistant(
        id,
        msg,
        {
          route: live.route,
          symbol: live.symbol,
          venue: live.venue,
          timeframe: live.timeframe,
          tab: live.tab ?? undefined,
          locale: i18n.language,
        },
        {
          onDelta: (d) => setMessages((m) => m.map((x) => (x.id === tmpId ? { ...x, content: x.content + d } : x))),
          onTool: (e) => setTool(e.status === 'start' ? e.name : e.status === 'error' ? `!${e.name}:${e.detail ?? ''}` : null),
          onCard: (card) => setMessages((m) => m.map((x) => (x.id === tmpId ? { ...x, cards: [...x.cards, card] } : x))),
        },
      );
      const offer: PatternOffer | undefined =
        patterns.length > 0 && !done.cards.some((c) => c.kind === 'proposal' || c.kind === 'backtest')
          ? { text: msg, patterns: patterns.map((p) => p.label), symbol: live.symbol, timeframe: live.timeframe }
          : undefined;
      setMessages((m) =>
        m.map((x) =>
          x.id === tmpId
            ? { id: done.messageId, role: 'assistant', content: done.content, cards: done.cards, ...(offer ? { patternOffer: offer } : {}) }
            : x,
        ),
      );
      void loadConversations();
      void trpc.assistant.status.query().then(setStatus).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages((m) => m.filter((x) => x.id !== tmpId));
    } finally {
      setBusy(false);
      setTool(null);
    }
  };

  const confirm = async (messageId: string, cardIndex: number, accept: boolean) => {
    try {
      const res = await trpc.assistant.confirm.mutate({ messageId, cardIndex, accept });
      setMessages((m) => m.map((x) => (x.id === messageId ? { ...x, cards: res.cards } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const newConversation = async () => {
    const c = await trpc.assistant.create.mutate();
    setConvId(c.id);
    setMessages([]);
    void loadConversations();
    inputRef.current?.focus();
  };

  const removeConversation = async () => {
    if (!convId) return;
    await trpc.assistant.remove.mutate({ id: convId });
    setConvId(null);
    setMessages([]);
    const rows = await loadConversations();
    if (rows[0]) {
      setConvId(rows[0].id);
      void loadMessages(rows[0].id);
    }
  };

  if (!open) return null;
  const toolLabel = (name: string) => (TOOL_KEYS.includes(name as (typeof TOOL_KEYS)[number]) ? t(`assistant.tool_${name}`) : name);
  const fmtPct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString(appLocale(), { maximumFractionDigits: 1 })} %`);
  const fmtNum = (v: number | null) => (v === null ? '—' : v.toLocaleString(appLocale(), { maximumFractionDigits: 2 }));

  return (
    <div className="chat-panel" role="dialog" aria-label={t('assistant.title')}>
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <span className="text-sm font-semibold">{t('assistant.title')}</span>
        {status && status.configured && (
          <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('assistant.budget', { spent: status.spentUsd.toLocaleString(appLocale(), { maximumFractionDigits: 2 }), budget: status.budgetUsd })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {conversations.length > 0 && (
            <select
              value={convId ?? ''}
              onChange={(e) => {
                setConvId(e.target.value);
                void loadMessages(e.target.value);
              }}
              className="field max-w-[9rem] px-2 py-1 text-xs"
              aria-label={t('assistant.conversations')}
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="tbtn" onClick={() => void newConversation()}>
            {t('assistant.newChat')}
          </button>
          {convId && (
            <button type="button" className="tbtn" onClick={() => void removeConversation()} title={t('assistant.delete')} aria-label={t('assistant.delete')}>
              🗑
            </button>
          )}
          <button type="button" className="tbtn" onClick={onClose} aria-label={t('assistant.close')}>
            ✕
          </button>
        </div>
      </div>

      {/* Live-Kontext-Leiste: zeigt dem Nutzer, was der Chat gerade mitliest */}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5 text-[11px]"
        style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.45)', color: 'var(--color-mut)' }}
      >
        <span style={{ color: 'var(--color-cyan)' }}>📍 Im Blick:</span>
        <span className="num font-medium" style={{ color: 'var(--color-ink)' }}>
          {uiCtx.symbol}
        </span>
        <span>·</span>
        <span className="num">{uiCtx.timeframe}</span>
        <span>·</span>
        <span>{uiCtx.pageLabel}{uiCtx.tab ? ` (${uiCtx.tab})` : ''}</span>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3">
        {status && !status.configured && (
          <div className="mb-3 rounded border p-3 text-xs space-y-1.5" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
            <p>
              <strong style={{ color: 'var(--color-cyan)' }}>Muster- & Strategie-Partner sofort aktiv:</strong> Schreib einfach ein Chartmuster (z. B. „RSI-Divergenz über EMA 200“ oder „EMA 20/50 Crossover“) — ich erstelle und teste deine Strategie direkt hier im Chat.
            </p>
            <p>
              {t('assistant.notConfigured')}{' '}
              <a href="#/einstellungen?tab=keys" className="underline" style={{ color: 'var(--color-blue)' }} onClick={onClose}>
                {t('assistant.toKeys')}
              </a>
            </p>
          </div>
        )}
        {messages.length === 0 && status && !status.configured && (
          <div className="mb-3 flex flex-col gap-1.5 text-xs">
            <span className="label">Schnell-Start Muster testen:</span>
            <button
              type="button"
              className="chip text-left"
              onClick={() => void buildPatternStrategyInChat(`Bullische RSI-Divergenz über EMA 200 auf ${uiCtx.symbol} im ${uiCtx.timeframe} Chart`)}
            >
              ✨ RSI-Divergenz + EMA200 auf {uiCtx.symbol} ({uiCtx.timeframe}) testen
            </button>
            <button
              type="button"
              className="chip text-left"
              onClick={() => void buildPatternStrategyInChat(`EMA 20 kreuzt EMA 50 mit ADX > 20 auf ${uiCtx.symbol} im ${uiCtx.timeframe} Chart`)}
            >
              ✨ EMA 20/50 Crossover + ADX auf {uiCtx.symbol} ({uiCtx.timeframe}) testen
            </button>
          </div>
        )}
        {messages.length === 0 && status?.configured && (
          <div className="text-sm" style={{ color: 'var(--color-mut)' }}>
            <p>{t('assistant.empty')}</p>
            <div className="mt-3 flex flex-col gap-2">
              {(['suggest1', 'suggest5', 'suggest2', 'suggest3', 'suggest4'] as const).map((k) => (
                <button key={k} type="button" className="chip text-left" onClick={() => void send(t(`assistant.${k}`))}>
                  {t(`assistant.${k}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[92%] rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? '' : 'w-full'}`} style={m.role === 'user' ? { background: 'var(--color-bg3)' } : {}}>
              <p className="whitespace-pre-wrap break-words">{m.content || (m.pending ? '…' : '')}</p>
              {m.cards.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  {m.cards.map((c, i) => (
                    <Card
                      key={i}
                      card={c}
                      onConfirm={(accept) => void confirm(m.id, i, accept)}
                      onNavigate={onClose}
                      onPrompt={(prompt) => void send(prompt)}
                      busy={busy}
                      t={t}
                      fmtPct={fmtPct}
                      fmtNum={fmtNum}
                    />
                  ))}
                </div>
              )}
              {m.patternOffer && (
                <div
                  className="mt-2 rounded-lg border p-2.5 text-xs space-y-2"
                  style={{ borderColor: 'rgba(6,182,212,0.45)', background: 'rgba(6,182,212,0.08)' }}
                >
                  <p className="font-medium" style={{ color: 'var(--color-cyan)' }}>
                    ✨ Muster erkannt: {m.patternOffer.patterns.join(' · ')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void buildPatternStrategyInChat(m.patternOffer!.text, m.patternOffer!.symbol, m.patternOffer!.timeframe)}
                      className="btn-primary px-3 py-1 text-[11px] disabled:opacity-50"
                    >
                      ▶ Ja, Strategie erstellen & auf {m.patternOffer.symbol} ({m.patternOffer.timeframe}) testen
                    </button>
                  </div>
                </div>
              )}
              {m.patternDraft && (
                <div className="mt-2">
                  <ChatPatternStrategyCard data={m.patternDraft} onNavigate={onClose} />
                </div>
              )}
            </div>
          </div>
        ))}
        {tool && (
          <p className="text-xs" style={{ color: tool.startsWith('!') ? 'var(--color-neg)' : 'var(--color-mut)' }}>
            {tool.startsWith('!') ? t('assistant.toolError', { name: toolLabel(tool.slice(1).split(':')[0] ?? ''), detail: tool.split(':').slice(1).join(':') }) : t('assistant.working', { name: toolLabel(tool) })}
          </p>
        )}
        {error && (
          <p className="text-xs" style={{ color: 'var(--color-neg)' }}>
            {error}
          </p>
        )}
      </div>

      {!busy && detectedPatterns.length > 0 && !looksLikeScriptOrStrategy(input) && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs"
          style={{ borderColor: 'var(--color-line)', background: 'rgba(6, 182, 212, 0.08)' }}
        >
          <span className="font-medium" style={{ color: 'var(--color-cyan)' }}>
            ✨ Muster erkannt ({detectedPatterns.map((p) => p.label).slice(0, 2).join(', ')}) — Strategie dazu erstellen & testen?
          </span>
          <button
            type="button"
            className="tbtn px-2.5 py-1 text-[11px]"
            style={{ borderColor: 'rgba(6,182,212,0.55)', color: 'var(--color-cyan)' }}
            onClick={() => void buildPatternStrategyInChat(input)}
          >
            ▶ Erstellen & auf {uiCtx.symbol} ({uiCtx.timeframe}) testen
          </button>
        </div>
      )}

      {!busy && status?.configured && looksLikeScriptOrStrategy(input) && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs"
          style={{ borderColor: 'var(--color-line)', background: 'rgba(59, 130, 246, 0.08)' }}
        >
          <span className="font-medium" style={{ color: 'var(--color-cyan)' }}>
            🔬 {t('assistant.scriptDetected')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="tbtn px-2 py-0.5 text-[11px]"
              onClick={() => {
                const sym = getSelectedAsset();
                void send(`${input.trim()}\n\n[Bitte per analyze_script analysieren, als Entwurf anlegen und auf ${sym} backtesten.]`);
              }}
            >
              ▶ {t('assistant.scriptActionAnalyzeAndTest', { symbol: getSelectedAsset() })}
            </button>
            <button
              type="button"
              className="tbtn px-2 py-0.5 text-[11px]"
              onClick={() => {
                void send(
                  `${input.trim()}\n\n[Bitte per analyze_script analysieren und per test_strategy_on_assets auf BTC/USDT, ETH/USDT und SOL/USDT backtesten und vergleichen.]`,
                );
              }}
            >
              🌐 {t('assistant.scriptActionMultiAsset')}
            </button>
          </div>
        </div>
      )}

      <form
        className="flex items-end gap-2 border-t px-3 py-2"
        style={{ borderColor: 'var(--color-line)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={2}
          placeholder={
            status?.configured === false
              ? 'Beschreibe ein Chartmuster (z. B. „RSI-Divergenz über EMA 200“) zum sofortigen Strategietest…'
              : t('assistant.placeholder')
          }
          className="field min-w-0 flex-1 resize-none px-3 py-2 text-sm"
          disabled={busy}
        />
        <button type="submit" className="btn-primary" disabled={busy || !input.trim()}>
          {t('assistant.send')}
        </button>
      </form>
    </div>
  );
}

function Card({
  card,
  onConfirm,
  onNavigate,
  onPrompt,
  busy,
  t,
  fmtPct,
  fmtNum,
}: {
  card: AssistantCard;
  onConfirm: (accept: boolean) => void;
  onNavigate: () => void;
  onPrompt: (prompt: string) => void;
  busy: boolean;
  t: (k: string, o?: Record<string, unknown>) => string;
  fmtPct: (v: number | null) => string;
  fmtNum: (v: number | null) => string;
}) {
  const box = { borderColor: 'var(--color-line)', background: 'var(--color-bg2)' };
  switch (card.kind) {
    case 'link':
      return (
        <a href={card.hash} className="chip self-start" onClick={onNavigate}>
          ↗ {card.label}
        </a>
      );
    case 'proposal':
      return (
        <div className="rounded-lg border p-2.5" style={box}>
          <p className="text-sm font-semibold">{card.name}</p>
          <p className="num text-xs" style={{ color: 'var(--color-mut)' }}>
            {card.symbol} · {card.timeframe} · {card.direction}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              className="tbtn px-2 py-0.5 text-[11px] disabled:opacity-50"
              onClick={() => onPrompt(t('assistant.promptTestAsset', { sessionId: card.sessionId, symbol: card.symbol, tf: card.timeframe }))}
            >
              ▶ {t('assistant.cardTestAsset', { symbol: card.symbol })}
            </button>
            <button
              type="button"
              disabled={busy}
              className="tbtn px-2 py-0.5 text-[11px] disabled:opacity-50"
              onClick={() => onPrompt(t('assistant.promptTestMulti', { sessionId: card.sessionId, tf: card.timeframe }))}
            >
              🌐 {t('assistant.cardTestMulti')}
            </button>
            <a href={card.hash} className="ml-auto text-xs underline" style={{ color: 'var(--color-blue)' }} onClick={onNavigate}>
              {t('assistant.cardOpenWorkshop')}
            </a>
          </div>
        </div>
      );
    case 'backtest':
      return (
        <div className="rounded-lg border p-2.5" style={box}>
          <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
            {card.label} · {card.symbol} · {card.timeframe}
          </p>
          <div className="num mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <span style={{ color: 'var(--color-mut)' }}>{t('assistant.cardNet')}</span>
            <span style={{ color: (card.netReturnPct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmtPct(card.netReturnPct)}</span>
            <span style={{ color: 'var(--color-mut)' }}>{t('assistant.cardPf')}</span>
            <span>{fmtNum(card.profitFactor)}</span>
            <span style={{ color: 'var(--color-mut)' }}>{t('assistant.cardDd')}</span>
            <span>{fmtPct(card.maxDrawdownPct)}</span>
            <span style={{ color: 'var(--color-mut)' }}>{t('assistant.cardWin')}</span>
            <span>{fmtPct(card.winRate)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
              {t('assistant.cardTrades', { n: card.trades, c: card.candles })}
            </span>
            <button
              type="button"
              disabled={busy}
              className="tbtn px-2 py-0.5 text-[11px] disabled:opacity-50"
              onClick={() => onPrompt(t('assistant.promptCompareAssets', { symbol: card.symbol }))}
            >
              🔄 {t('assistant.cardCompareOtherAssets')}
            </button>
          </div>
        </div>
      );
    case 'version':
      return (
        <a href={card.hash} className="chip self-start" onClick={onNavigate}>
          {t('assistant.cardVersion', { n: card.version, status: card.status })}
        </a>
      );
    case 'screen':
      return (
        <div className="rounded-lg border p-2.5" style={box}>
          <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('assistant.cardScreen', { m: card.matched.length, s: card.scanned, tf: card.timeframe })}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {card.matched.length === 0 && <span className="text-xs">{t('assistant.cardNoMatch')}</span>}
            {card.matched.map((s) => (
              <a key={s} href={`#/charts?symbol=${encodeURIComponent(s)}&tf=${card.timeframe}`} className="chip num" onClick={onNavigate}>
                {s}
              </a>
            ))}
          </div>
        </div>
      );
    case 'confirm':
      return (
        <div className="rounded-lg border p-2.5" style={{ ...box, borderColor: card.status === 'pending' ? 'var(--color-warn)' : 'var(--color-line)' }}>
          <p className="text-sm">{card.label}</p>
          {card.status === 'pending' ? (
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-primary" onClick={() => onConfirm(true)}>
                {t('assistant.confirm')}
              </button>
              <button type="button" className="btn" onClick={() => onConfirm(false)}>
                {t('assistant.decline')}
              </button>
            </div>
          ) : (
            <p className="mt-1 text-xs" style={{ color: card.status === 'done' ? 'var(--color-pos)' : card.status === 'failed' ? 'var(--color-neg)' : 'var(--color-mut)' }}>
              {t(`assistant.${card.status === 'done' ? 'confirmed' : card.status === 'failed' ? 'failed' : 'declined'}`)}
              {card.note ? ` — ${card.note}` : ''}
            </p>
          )}
        </div>
      );
    default:
      return null;
  }
}
