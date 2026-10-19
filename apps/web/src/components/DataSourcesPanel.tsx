import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, Panel, fmtNum } from './ui.js';
import { Sparkline } from './Sparkline.js';

/**
 * Daten-Assistent (Marktlage → Datenquellen): Klartext („Geldmenge",
 * „Zinskurve") → echte FRED-IDs; Hinzufügen prüft die Serie gegen FRED und
 * speichert nur echte Punkte. Kein Treffer → ehrlich sagen, direkte ID geht.
 */

type Suggestion = Awaited<ReturnType<typeof trpc.market.dataSuggest.query>>[number];
type Watch = Awaited<ReturnType<typeof trpc.market.dataWatchlist.query>>[number];

export function DataSourcesPanel() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [directId, setDirectId] = useState('');
  const [watch, setWatch] = useState<Watch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    try {
      setWatch(await trpc.market.dataWatchlist.query());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      trpc.market.dataSuggest
        .query({ query: q })
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  async function add(seriesId: string) {
    setBusy(seriesId);
    setMessage(null);
    try {
      const res = await trpc.market.dataAdd.mutate({ seriesId });
      setMessage({ ok: true, text: t('data.added', { id: res.seriesId, n: res.points }) });
      setDirectId('');
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setBusy(null);
    }
  }

  async function remove(seriesId: string) {
    try {
      await trpc.market.dataRemove.mutate({ seriesId });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    }
  }

  const watched = new Set((watch ?? []).map((w) => w.seriesId));
  const field = 'field w-full px-3 py-2 text-sm';

  return (
    <div className="grid gap-5">
      <Panel label={t('ia.tab_daten')} stagger={1}>
        <p className="mb-4 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('data.subtitle')}
        </p>
        <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
          <input className={field} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('data.ask')} />
          <div className="flex gap-2">
            <input
              className={`${field} num`}
              value={directId}
              onChange={(e) => setDirectId(e.target.value.toUpperCase())}
              placeholder={t('data.idLabel')}
              spellCheck={false}
            />
            <button className="btn shrink-0" disabled={!directId.trim() || busy !== null} onClick={() => void add(directId.trim())}>
              {busy === directId.trim() ? t('data.adding') : t('data.add')}
            </button>
          </div>
        </div>
        {query.trim() && suggestions.length === 0 && (
          <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('data.noMatch')}
          </p>
        )}
        {suggestions.length > 0 && (
          <ul className="mt-3 space-y-2">
            {suggestions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2" style={{ borderColor: 'var(--color-line)' }}>
                <span className="text-sm">
                  <span className="num font-medium">{s.id}</span>{' '}
                  <span style={{ color: 'var(--color-mut)' }}>· {s.title}</span>
                </span>
                {watched.has(s.id) ? (
                  <span className="text-xs" style={{ color: 'var(--color-pos)' }}>
                    {t('data.onWatch')}
                  </span>
                ) : (
                  <button className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--color-line)' }} disabled={busy !== null} onClick={() => void add(s.id)}>
                    {busy === s.id ? t('data.adding') : t('data.add')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {message && (
          <p className="mt-3 text-sm" style={{ color: message.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {message.text}
          </p>
        )}
      </Panel>

      <Panel label={t('data.watchlist')} stagger={2}>
        {error && <ErrorBox message={error} />}
        {watch === null && !error && <Loading />}
        {watch !== null && watch.length === 0 && <Empty text={t('data.empty')} />}
        {watch !== null && watch.length > 0 && (
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {watch.map((w) => {
              const change = w.previous === null ? null : w.latest - w.previous;
              return (
                <li key={w.seriesId} className="rounded border p-3" style={{ borderColor: 'var(--color-line)' }}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <a
                        className="num text-sm font-medium"
                        href={`https://fred.stlouisfed.org/series/${encodeURIComponent(w.seriesId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {w.seriesId}
                      </a>
                      {w.title && (
                        <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                          {w.title}
                        </p>
                      )}
                    </div>
                    <button className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }} onClick={() => void remove(w.seriesId)}>
                      {t('data.remove')}
                    </button>
                  </div>
                  <p className="num mt-2 text-lg">
                    {fmtNum(w.latest, Math.abs(w.latest) >= 1000 ? 0 : 2)}
                    {change !== null && (
                      <span className="ml-2 text-xs" style={{ color: change >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                        {change >= 0 ? '+' : ''}
                        {fmtNum(change, Math.abs(change) >= 1000 ? 0 : 2)}
                      </span>
                    )}
                  </p>
                  <Sparkline closes={w.series.map((p) => p.value)} id={`fred-${w.seriesId}`} height={44} />
                  <p className="mt-1 text-xs" style={{ color: 'var(--color-mut)' }}>
                    {t('data.asOf', { date: new Date(w.latestTs).toLocaleDateString(i18n.language) })} · {t('data.points', { n: w.points })}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('data.source')}
        </p>
      </Panel>
    </div>
  );
}
