import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui.js';

/** Magazin (09_ §3.6): echte v1-Artikel aus der DB; Live-News-Quelle folgt (Phase-1-Rest). */

type Article = Awaited<ReturnType<typeof trpc.product.articles.query>>[number];

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
          {a.publishedAt ? new Date(a.publishedAt).toLocaleDateString() : new Date(a.createdAt).toLocaleDateString()}
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
