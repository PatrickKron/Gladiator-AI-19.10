import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui.js';
import { groupNewsByFavorites } from '../lib/newsMatch.js';
import { groupByDay, newsWhen } from '../lib/news-time.js';
import { appLocale } from '../lib/locale.js';

/** Magazin (09_ §3.6): echte v1-Artikel aus der DB + Live-News mit Favoriten-Fokus. */

type Article = Awaited<ReturnType<typeof trpc.product.articles.query>>[number];
type NewsItem = Awaited<ReturnType<typeof trpc.market.news.query>>[number];
type Favorite = Awaited<ReturnType<typeof trpc.product.favorites.query>>[number];

/**
 * Eine News-Zeile (Patricks Mängelliste 2026-10-22, Punkt 7): relative UND absolute Zeit,
 * Quelle, Titel, Kurztext (wenn der Feed einen liefert) und „Betrifft“-Chips für die
 * ★-Favoriten, die die Meldung trifft. Auf dem Handy bricht alles um — nichts wird abgeschnitten.
 */
type Affect = { ticker: string; fav: boolean };

function NewsRow({ n, now, affects }: { n: NewsItem; now: Date; affects?: Affect[] }) {
  const { t } = useTranslation();
  const when = newsWhen(n.publishedAt, now, appLocale(), { today: t('magazine.today'), yesterday: t('magazine.yesterday') });
  return (
    <li className="border-b py-2.5 last:border-b-0" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" style={{ color: 'var(--color-mut)' }}>
        <span className="num font-medium" style={{ color: 'var(--color-ink)' }} title={when.absolute}>
          {when.relative}
        </span>
        <span className="num">{when.absolute}</span>
        <span className="label rounded border px-1 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
          {n.source}
        </span>
        {affects && affects.length > 0 && (
          <span className="flex flex-wrap items-center gap-1">
            <span>{t('magazine.affects')}</span>
            {affects.map((a) => (
              <span key={a.ticker} className="num rounded border px-1 py-0.5" style={a.fav ? { borderColor: 'rgba(245,158,11,0.4)', color: 'var(--color-warn)' } : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                {a.fav ? '★ ' : ''}
                {a.ticker}
              </span>
            ))}
          </span>
        )}
      </div>
      <a href={n.url} target="_blank" rel="noreferrer" className="mt-0.5 block text-[15px] leading-snug hover:underline" style={{ color: 'var(--color-ink)' }}>
        {n.title}
      </a>
      {n.summary && (
        <p className="mt-0.5 line-clamp-2 text-sm leading-snug" style={{ color: 'var(--color-mut)' }}>
          {n.summary}
        </p>
      )}
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
  // Mängelliste 7: Relevanz über die Favoriten hinaus — auch das Scan-Universum (Symbole mit echten Kerzen).
  const [universe, setUniverse] = useState<{ ticker: string; name: string }[]>([]);
  const [summary, setSummary] = useState<{ text: string; costUsd: number } | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // 60 Items: mehr echtes Material für den Favoriten-Abgleich und die Tagesgruppen.: mehr echtes Material für den Favoriten-Abgleich.
    void trpc.market.news.query({ limit: 60 }).then(setNews).catch(() => setNews([]));
    void trpc.product.favorites.query().then(setFavorites).catch(() => setFavorites([]));
    // Namen aus der Asset-Tabelle (BTC ↔ „Bitcoin“), wo vorhanden — sonst nur der Ticker.
    void Promise.all([trpc.market.scanUniverse.query(), trpc.product.allAssets.query().catch(() => [])])
      .then(([u, all]) => {
        const names = new Map(all.map((a) => [a.ticker.toUpperCase(), a.name]));
        const tickers = [...new Set(u.map((sym) => sym.split('/')[0]!.toUpperCase()))];
        setUniverse(tickers.map((tk) => ({ ticker: tk, name: names.get(tk) ?? tk })));
      })
      .catch(() => setUniverse([]));
  }, []);

  const grouped = useMemo(
    () => {
      const favs = (favorites ?? []).map((f) => ({ ticker: f.ticker, name: f.name }));
      const favSet = new Set(favs.map((f) => f.ticker.toUpperCase()));
      const uni = universe.filter((u) => !favSet.has(u.ticker));
      return groupNewsByFavorites(news ?? [], [...favs, ...uni]);
    },
    [news, favorites, universe],
  );
  const favTickers = useMemo(() => new Set((favorites ?? []).map((f) => f.ticker.toUpperCase())), [favorites]);
  const favGroups = grouped.groups.filter((g) => favTickers.has(g.ticker.toUpperCase()));
  const uniGroups = grouped.groups.filter((g) => !favTickers.has(g.ticker.toUpperCase()));
  const loading = news === null || favorites === null;
  // Welche Märkte trifft eine Meldung? (für die „Betrifft“-Chips — ★ nur bei Favoriten)
  const affectsByUrl = useMemo(() => {
    const m = new Map<string, Affect[]>();
    for (const g of grouped.groups) for (const n of g.items) m.set(n.url, [...(m.get(n.url) ?? []), { ticker: g.ticker, fav: favTickers.has(g.ticker.toUpperCase()) }]);
    return m;
  }, [grouped, favTickers]);
  const dayLabels = { today: t('magazine.today'), yesterday: t('magazine.yesterday') };
  // Rest nach Tagen gruppiert (neueste zuerst), gekappt, damit die Seite nicht endlos wird.
  const restShown = grouped.rest.slice(0, 40);
  const restDays = useMemo(() => groupByDay(restShown, now, appLocale(), dayLabels), [restShown, now, dayLabels.today, dayLabels.yesterday]);
  const newest = news && news.length > 0 ? news.reduce((a, b) => (new Date(a.publishedAt) > new Date(b.publishedAt) ? a : b)) : null;

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
      ) : favGroups.length === 0 ? (
        <Empty
          text={t('magazine.noFavoriteNews', {
            tickers: [...new Set(favorites.map((f) => f.ticker))].join(', '),
          })}
        />
      ) : (
        <>
          <div className="mt-4 space-y-4">
            {favGroups.map((g) => (
              <div key={g.ticker} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(245,158,11,0.3)' }}>
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span style={{ color: 'var(--color-warn)' }}>{'★'}</span>
                  <span className="text-[15px] leading-snug font-medium">{g.name}</span>
                  <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
                    {g.ticker}
                  </span>
                  <span className="label ml-auto shrink-0">{t('magazine.matchCount', { n: g.items.length })}</span>
                </p>
                <ul className="mt-2">
                  {g.items.map((n) => (
                    <NewsRow key={n.id} n={n} now={now} />
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
            <div className="mt-3 rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(148,163,184,0.35)' }}>
              <p className="label" style={{ color: 'var(--color-violet)' }}>
                {t('magazine.summaryTitle')}
              </p>
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{summary.text}</p>
              <p className="label mt-3">{t('magazine.summaryCost', { usd: summary.costUsd.toFixed(4) })}</p>
            </div>
          )}
        </>
      )}

      {/* ── Aus dem Scan-Universum: Treffer zu Symbolen mit echten Kerzen, die keine Favoriten sind ── */}
      {!loading && uniGroups.length > 0 && (
        <>
          <h2 className="label mt-6">{t('magazine.fromUniverse')}</h2>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('magazine.fromUniverseHint')}
          </p>
          <div className="mt-3 space-y-3">
            {uniGroups.map((g) => (
              <div key={g.ticker} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  {g.name !== g.ticker && <span className="text-[15px] leading-snug font-medium">{g.name}</span>}
                  <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
                    {g.ticker}
                  </span>
                  <span className="label ml-auto shrink-0">{t('magazine.matchCount', { n: g.items.length })}</span>
                </p>
                <ul className="mt-2">
                  {g.items.map((n) => (
                    <NewsRow key={n.id} n={n} now={now} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Alle News: der Rest ohne Treffer ── */}
      <div
        className="mt-6 h-px w-full"
        style={{ background: 'linear-gradient(90deg, rgba(59,130,246,0.5), rgba(148,163,184,0.35), transparent 80%)' }}
      />
      <h2 className="label mt-5">{t('magazine.allNews')}</h2>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('magazine.newsTitle')}
        {newest && (
          <>
            {' · '}
            {t('magazine.newest', { when: newsWhen(newest.publishedAt, now, appLocale(), dayLabels).relative })}
          </>
        )}
      </p>
      {news === null ? (
        <Loading />
      ) : news.length === 0 ? (
        <Empty text={t('magazine.newsEmpty')} />
      ) : restShown.length === 0 ? (
        <Empty text={t('magazine.allNewsAllMatched')} />
      ) : (
        <>
          {restDays.map((d) => (
            <div key={d.day} className="mt-3">
              <p className="label sticky top-0 py-1" style={{ background: 'var(--color-bg2)' }}>
                {d.day} · {t('magazine.countOnDay', { n: d.items.length })}
              </p>
              <ul>
                {d.items.map((n) => (
                  <NewsRow key={n.id} n={n} now={now} affects={affectsByUrl.get(n.url)} />
                ))}
              </ul>
            </div>
          ))}
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
        <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(148,163,184,0.4)', color: 'var(--color-violet)' }}>
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
