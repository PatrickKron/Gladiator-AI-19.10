import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui.js';
import { groupNewsByFavorites } from '../lib/newsMatch.js';
import { appLocale } from '../lib/locale.js';

/** Magazin (09_ §3.6): echte v1-Artikel aus der DB + Live-News mit Favoriten-Fokus. */

type Article = Awaited<ReturnType<typeof trpc.product.articles.query>>[number];
type NewsItem = Awaited<ReturnType<typeof trpc.market.news.query>>[number];
type Favorite = Awaited<ReturnType<typeof trpc.product.favorites.query>>[number];

/**
 * Eine News-Zeile (Zeit · Quelle · Titel). Auf Mobil (375 px) rutscht der
 * Titel auf eine eigene Zeile — Lesbarkeit vor Dichte (Patricks Feedback).
 */
function NewsRow({ n }: { n: NewsItem }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="num shrink-0 text-xs" style={{ color: 'var(--color-mut)' }}>
        {new Date(n.publishedAt).toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' })}
      </span>
      <span className="label shrink-0 rounded border px-1 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
        {n.source}
      </span>
      <a
        href={n.url}
        target="_blank"
        rel="noreferrer"
        className="w-full min-w-0 leading-snug hover:underline sm:w-auto sm:flex-1"
        style={{ color: 'var(--color-ink)' }}
      >
        {n.title}
      </a>
    </li>
  );
}

/**
 * Live-News mit Favoriten-Fokus (Patrick: „das Wichtigste zu meinen Favoriten
 * zusammengefasst"): oben „Für meine Märkte" — echte RSS-Schlagzeilen, die per
 * Wortabgleich (lib/newsMatch) Ticker ODER Namen der ★-Favoriten treffen, je
 * Favorit gruppiert mit Zähler — darunter der Rest als „Alle News". Die
 * KI-Zusammenfassung läuft über den guarded-LLM-Endpoint (market.newsSummarize);
 * ohne ANTHROPIC_API_KEY zeigt der Button die ehrliche Server-Meldung, nie Fake.
 */
function NewsPanel() {
  const { t, i18n } = useTranslation();
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [favorites, setFavorites] = useState<Favorite[] | null>(null);
  const [summary, setSummary] = useState<{ text: string; costUsd: number } | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    // 40 statt 12 Items: mehr echtes Material für den Favoriten-Abgleich.
    void trpc.market.news.query({ limit: 40 }).then(setNews).catch(() => setNews([]));
    void trpc.product.favorites.query().then(setFavorites).catch(() => setFavorites([]));
  }, []);

  const grouped = useMemo(
    () => groupNewsByFavorites(news ?? [], (favorites ?? []).map((f) => ({ ticker: f.ticker, name: f.name }))),
    [news, favorites],
  );
  const loading = news === null || favorites === null;
  // Rest kappen, damit „Alle News" die Favoriten-Sektion nicht erdrückt.
  const restShown = grouped.rest.slice(0, 15);

  async function summarize() {
    // Jede Schlagzeile nur EINMAL ans LLM — trifft sie mehrere Favoriten,
    // werden deren Ticker gebündelt (spart Budget, vermeidet Dopplungen).
    const byUrl = new Map<string, { title: string; source: string; publishedAt: string; favorites: string[] }>();
    for (const g of grouped.groups) {
      for (const n of g.items) {
        const cur = byUrl.get(n.url) ?? {
          title: n.title,
          source: n.source,
          publishedAt: new Date(n.publishedAt).toISOString(),
          favorites: [],
        };
        if (!cur.favorites.includes(g.ticker)) cur.favorites.push(g.ticker);
        byUrl.set(n.url, cur);
      }
    }
    const items = [...byUrl.values()].slice(0, 24);
    if (items.length === 0) return;
    setSummaryBusy(true);
    setSummaryError(null);
    try {
      // Nur der 2-Buchstaben-Code — i18next kann regionale Varianten liefern (de-DE).
      const res = await trpc.market.newsSummarize.mutate({ items, language: i18n.language.slice(0, 2) });
      setSummary({ text: res.summary, costUsd: res.costUsd });
    } catch (err) {
      // Ehrliche Server-Meldung (z. B. „ANTHROPIC_API_KEY fehlt") statt Fake-Summary.
      setSummaryError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSummaryBusy(false);
    }
  }

  return (
    <section className="glass reveal mb-6 p-5" style={{ '--stagger': 1 } as React.CSSProperties}>
      {/* ── Für meine Märkte: Favoriten-Treffer zuerst ── */}
      <h2 className="label">{t('magazine.forMyMarkets')}</h2>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('magazine.forMyMarketsHint')}
      </p>

      {loading ? (
        <Loading />
      ) : favorites.length === 0 ? (
        <div className="mt-4 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          <p>{t('magazine.noFavorites')}</p>
          <p className="mt-2">
            <a href="#/pakete" className="hover:underline" style={{ color: 'var(--color-cyan)' }}>
              → {t('nav.packages')}
            </a>
            <span className="mx-2">·</span>
            <a href="#/charts" className="hover:underline" style={{ color: 'var(--color-cyan)' }}>
              → {t('nav.assets')}
            </a>
          </p>
        </div>
      ) : grouped.groups.length === 0 ? (
        <Empty
          text={t('magazine.noFavoriteNews', {
            tickers: [...new Set(favorites.map((f) => f.ticker))].join(', '),
          })}
        />
      ) : (
        <>
          <div className="mt-4 space-y-4">
            {grouped.groups.map((g) => (
              <div key={g.ticker} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(232,184,75,0.3)' }}>
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span style={{ color: 'var(--color-warn)' }}>{'★'}</span>
                  <span className="text-[15px] leading-snug font-medium">{g.name}</span>
                  <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
                    {g.ticker}
                  </span>
                  <span className="label ml-auto shrink-0">{t('magazine.matchCount', { n: g.items.length })}</span>
                </p>
                <ul className="mt-3 space-y-2.5">
                  {g.items.map((n) => (
                    <NewsRow key={n.id} n={n} />
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* KI-Zusammenfassung: guarded LLM — ohne Key kommt die ehrliche Fehlermeldung. */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={() => void summarize()} disabled={summaryBusy} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
              {summaryBusy ? t('magazine.summarizing') : t('magazine.summarizeBtn')}
            </button>
            <span className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('magazine.summarizeHint')}
            </span>
          </div>
          {summaryError && (
            <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--color-neg)' }}>
              {summaryError}
            </p>
          )}
          {summary && (
            <div className="mt-3 rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(139,92,246,0.35)' }}>
              <p className="label" style={{ color: 'var(--color-violet)' }}>
                {t('magazine.summaryTitle')}
              </p>
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{summary.text}</p>
              <p className="label mt-3">{t('magazine.summaryCost', { usd: summary.costUsd.toFixed(4) })}</p>
            </div>
          )}
        </>
      )}

      {/* ── Alle News: der Rest ohne Favoriten-Treffer ── */}
      <div
        className="mt-6 h-px w-full"
        style={{ background: 'linear-gradient(90deg, rgba(46,124,246,0.5), rgba(139,92,246,0.35), transparent 80%)' }}
      />
      <h2 className="label mt-5">{t('magazine.allNews')}</h2>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('magazine.newsTitle')}
      </p>
      {news === null ? (
        <Loading />
      ) : news.length === 0 ? (
        <Empty text={t('magazine.newsEmpty')} />
      ) : restShown.length === 0 ? (
        <Empty text={t('magazine.allNewsAllMatched')} />
      ) : (
        <>
          <ul className="mt-3 space-y-2.5">
            {restShown.map((n) => (
              <NewsRow key={n.id} n={n} />
            ))}
          </ul>
          {grouped.rest.length > restShown.length && (
            <p className="label mt-3">{t('magazine.moreNews', { n: grouped.rest.length - restShown.length })}</p>
          )}
        </>
      )}
    </section>
  );
}

function ArticleCard({ a, stagger }: { a: Article; stagger: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <article className="glass glass-hover reveal p-5" style={{ '--stagger': Math.min(stagger, 10) } as React.CSSProperties}>
      <div className="flex items-center gap-2">
        <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(139,92,246,0.4)', color: 'var(--color-violet)' }}>
          {a.category}
        </span>
        {!a.isPublished && (
          <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
            {t('magazine.unpublished')}
          </span>
        )}
        <span className="label ml-auto">
          {a.publishedAt ? new Date(a.publishedAt).toLocaleDateString(appLocale()) : new Date(a.createdAt).toLocaleDateString(appLocale())}
        </span>
      </div>
      <h2 className="mt-3 text-[15px] leading-snug font-medium">{a.title}</h2>
      {a.summary && (
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {a.summary}
        </p>
      )}
      {open && (
        <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--color-ink)' }}>
          {a.content}
        </p>
      )}
      <div className="mt-3 flex items-center gap-4">
        <button onClick={() => setOpen(!open)} className="text-xs" style={{ color: 'var(--color-cyan)' }}>
          {open ? `− ${t('magazine.collapse')}` : `+ ${t('magazine.readMore')}`}
        </button>
        {a.sourceUrl && (
          <a href={a.sourceUrl} target="_blank" rel="noreferrer" className="text-xs" style={{ color: 'var(--color-mut)' }}>
            ↗ {a.sourceUrl.replace(/^https?:\/\//, '').split('/')[0]}
          </a>
        )}
      </div>
    </article>
  );
}

export function Magazine() {
  const { t } = useTranslation();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [category, setCategory] = useState('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.product.articles
      .query({ limit: 100 })
      .then(setArticles)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('common.error')));
  }, []);

  const categories = useMemo(() => [...new Set((articles ?? []).map((a) => a.category))].sort(), [articles]);
  const filtered = useMemo(
    () => (articles ?? []).filter((a) => category === 'all' || a.category === category),
    [articles, category],
  );

  return (
    <div>
      <PageHeader
        title={t('magazine.title')}
        subtitle={t('magazine.subtitle', { count: articles?.length ?? '…' })}
        right={
          <select className="field cursor-pointer px-2.5 py-1.5 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">{t('magazine.categoryAll')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        }
      />
      {error && <ErrorBox message={error} />}
      <NewsPanel />
      {articles === null ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass p-6">
          <Empty text={t('magazine.empty')} />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((a, i) => (
            <ArticleCard key={a.id} a={a} stagger={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
