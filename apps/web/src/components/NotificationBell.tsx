import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push.js';

/**
 * Glocke in der Kopfleiste (Vision-Punkt 3): Signale, Preis-Alarme, Notfälle,
 * Kill-Switch und Briefing an EINER Stelle — Ungelesen-Zähler, Liste, Abhaken.
 * Unten: Push auf diesem Gerät an/aus + Test (ehrlich „nicht eingerichtet“ ohne VAPID).
 */

type Item = Awaited<ReturnType<typeof trpc.notifications.list.query>>[number];
type PushStatus = Awaited<ReturnType<typeof trpc.notifications.pushStatus.query>>;

const SEVERITY_COLOR: Record<string, string> = {
  info: 'var(--color-cyan)',
  warn: 'var(--color-warn)',
  critical: 'var(--color-neg)',
};

export function NotificationBell() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Item[] | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [deviceOn, setDeviceOn] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(() => {
    trpc.notifications.unreadCount
      .query()
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = setVisibleInterval(refreshCount, 30_000);
    return () => clearVisibleInterval(timer);
  }, [refreshCount]);

  async function load() {
    const [list, status, sub] = await Promise.all([
      trpc.notifications.list.query({ limit: 30 }),
      trpc.notifications.pushStatus.query(),
      currentSubscription().catch(() => null),
    ]);
    setItems(list);
    setPush(status);
    setDeviceOn(sub !== null);
  }

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    void load().catch((err: unknown) => setMsg(err instanceof Error ? err.message : t('common.error')));
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function openItem(n: Item) {
    if (!n.read) {
      await trpc.notifications.markRead.mutate({ ids: [n.id] }).catch(() => {});
      refreshCount();
    }
    setOpen(false);
    if (n.link) window.location.hash = n.link.replace(/^#/, '');
  }

  async function markAll() {
    await trpc.notifications.markAllRead.mutate();
    refreshCount();
    await load();
  }

  async function togglePush() {
    if (!push?.publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      if (deviceOn) {
        await disablePush();
        setMsg(t('notif.pushOff'));
      } else {
        const r = await enablePush(push.publicKey);
        setMsg(t(`notif.push_${r}`));
      }
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const r = await trpc.notifications.test.mutate();
      setMsg(t('notif.testSent', { pushed: r.pushed }));
      refreshCount();
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-[0.625rem] border px-2 py-1.5"
        style={{ borderColor: 'var(--color-line)', color: unread > 0 ? 'var(--color-ink)' : 'var(--color-mut)' }}
        aria-label={t('notif.title')}
        title={t('notif.title')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
        </svg>
        {unread > 0 && (
          <span
            className="num absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full px-1 text-center text-[10px] leading-[18px]"
            style={{ background: 'var(--color-neg)', color: '#fff' }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          // Position als Style: .glass setzt selbst position:relative und würde „absolute" überstimmen
          className="glass z-50 w-[min(92vw,380px)] p-3"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', background: 'rgba(9,12,32,0.97)', backdropFilter: 'blur(18px)' }}
          role="dialog"
          aria-label={t('notif.title')}
        >
          <div className="flex items-center justify-between">
            <p className="label">{t('notif.title')}</p>
            <button type="button" onClick={() => void markAll()} className="text-xs" style={{ color: 'var(--color-cyan)' }} disabled={unread === 0}>
              {t('notif.markAll')}
            </button>
          </div>

          <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto pr-1">
            {items === null && <li className="text-xs" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</li>}
            {items?.length === 0 && <li className="text-xs" style={{ color: 'var(--color-mut)' }}>{t('notif.empty')}</li>}
            {items?.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => void openItem(n)}
                  className="w-full rounded border px-2.5 py-2 text-left"
                  style={{ borderColor: 'var(--color-line)', opacity: n.read ? 0.6 : 1 }}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: SEVERITY_COLOR[n.severity] ?? 'var(--color-cyan)' }} />
                      {n.title}
                    </span>
                    <span className="num shrink-0 text-[10px]" style={{ color: 'var(--color-mut)' }}>
                      {new Date(n.createdAt).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block whitespace-pre-line text-xs" style={{ color: 'var(--color-mut)' }}>
                    {n.body}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-3 border-t pt-2.5 text-xs" style={{ borderColor: 'var(--color-line)' }}>
            {!pushSupported() ? (
              <p style={{ color: 'var(--color-mut)' }}>{t('notif.pushUnsupported')}</p>
            ) : push && !push.configured ? (
              <p style={{ color: 'var(--color-mut)' }}>{t('notif.pushNotConfigured')}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn px-2.5 py-1 text-xs" disabled={busy || !push} onClick={() => void togglePush()}>
                  {deviceOn ? t('notif.pushDisable') : t('notif.pushEnable')}
                </button>
                <button type="button" className="rounded border px-2.5 py-1" style={{ borderColor: 'var(--color-line)' }} disabled={busy} onClick={() => void sendTest()}>
                  {t('notif.test')}
                </button>
                {push && <span style={{ color: 'var(--color-mut)' }}>{t('notif.devices', { n: push.devices })}</span>}
              </div>
            )}
            {msg && <p className="mt-1.5" style={{ color: 'var(--color-mut)' }}>{msg}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
