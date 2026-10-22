import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { streamAssistant, trpc, type AssistantCard } from '../api.js';
import { getSelectedAsset } from './AssetSelect.js';
import { appLocale } from '../lib/locale.js';

/**
 * Gladiator-Chat (Patricks Mängelliste 2026-10-22, Punkt 4): EIN Dialog, überall erreichbar,
 * der in die App eingreift — Strategien entwerfen, backtesten, speichern, zur Nutzung
 * vorschlagen (Bestätigung durch den Nutzer), Markt screenen, Seiten öffnen. Jede Zahl in
 * einer Karte stammt aus einem echten Werkzeug-Lauf; ohne Anthropic-Schlüssel ehrlich
 * „nicht verbunden“ mit dem Weg zu den Einstellungen.
 */

type Msg = { id: string; role: 'user' | 'assistant'; content: string; cards: AssistantCard[]; pending?: boolean };
type Status = Awaited<ReturnType<typeof trpc.assistant.status.query>>;
type Conversation = Awaited<ReturnType<typeof trpc.assistant.conversations.query>>[number];

const CONV_KEY = 'gladiator.chatConversation';
const TOOL_KEYS = ['app_overview', 'propose_strategy', 'run_backtest', 'save_version', 'lab_backtest', 'promote_version', 'run_screen', 'navigate'] as const;

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
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  const send = async (text: string) => {
    const msg = text.trim();
    if (!msg || busy) return;
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
        { route: window.location.hash || '#/', symbol: getSelectedAsset(), locale: i18n.language },
        {
          onDelta: (d) => setMessages((m) => m.map((x) => (x.id === tmpId ? { ...x, content: x.content + d } : x))),
          onTool: (e) => setTool(e.status === 'start' ? e.name : e.status === 'error' ? `!${e.name}:${e.detail ?? ''}` : null),
          onCard: (card) => setMessages((m) => m.map((x) => (x.id === tmpId ? { ...x, cards: [...x.cards, card] } : x))),
        },
      );
      setMessages((m) => m.map((x) => (x.id === tmpId ? { id: done.messageId, role: 'assistant', content: done.content, cards: done.cards } : x)));
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

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3">
        {status && !status.configured && (
          <div className="rounded border p-3 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
            {t('assistant.notConfigured')}{' '}
            <a href="#/einstellungen?tab=keys" className="underline" style={{ color: 'var(--color-blue)' }} onClick={onClose}>
              {t('assistant.toKeys')}
            </a>
          </div>
        )}
        {messages.length === 0 && status?.configured && (
          <div className="text-sm" style={{ color: 'var(--color-mut)' }}>
            <p>{t('assistant.empty')}</p>
            <div className="mt-3 flex flex-col gap-2">
              {(['suggest1', 'suggest2', 'suggest3'] as const).map((k) => (
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
                    <Card key={i} card={c} onConfirm={(accept) => void confirm(m.id, i, accept)} onNavigate={onClose} t={t} fmtPct={fmtPct} fmtNum={fmtNum} />
                  ))}
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
          placeholder={t('assistant.placeholder')}
          className="field min-w-0 flex-1 resize-none px-3 py-2 text-sm"
          disabled={busy || status?.configured === false}
        />
        <button type="submit" className="btn-primary" disabled={busy || !input.trim() || status?.configured === false}>
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
  t,
  fmtPct,
  fmtNum,
}: {
  card: AssistantCard;
  onConfirm: (accept: boolean) => void;
  onNavigate: () => void;
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
          <a href={card.hash} className="mt-1 inline-block text-xs underline" style={{ color: 'var(--color-blue)' }} onClick={onNavigate}>
            {t('assistant.cardOpenWorkshop')}
          </a>
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
          <p className="num mt-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('assistant.cardTrades', { n: card.trades, c: card.candles })}
          </p>
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
