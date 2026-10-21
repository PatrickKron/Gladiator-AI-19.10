import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { rankAssets } from '../lib/asset-search.js';

/**
 * „+ Markt hinzufügen“ auf dem Dashboard (Patrick: „wenn ich bei der Übersicht
 * neue Sachen reinhaben will, krieg ich sie nicht rein“): Inline-Picker über
 * product.allAssets — ALLE Anlageklassen wählbar, client-seitig nach Ticker
 * und Name gefiltert. Bewusst rankAssets aus der Command-Palette wiederverwendet,
 * damit es keine zweite Such-/Ranking-Wahrheit gibt. Ein Klick auf eine Zeile
 * toggelt den echten Stern-Favoriten (product.toggleFavorite) und meldet die
 * Änderung nach oben, damit „Meine Märkte“ sofort neu lädt.
 */

type PickerAsset = Awaited<ReturnType<typeof trpc.product.allAssets.query>>[number];

// Farbcode je Anlageklasse — identisch zur Command-Palette (dort nicht
// exportiert; gemeinsame Komponenten bleiben laut Auftrag unangetastet).
// Lookup kleingeschrieben: die Live-DB liefert 'CRYPTO'/'STOCK'/'ETF'/… in
// Großbuchstaben, sonst fiele jede Klasse stumm auf die Muted-Farbe zurück.
const TYPE_COLOR: Record<string, string> = {
  crypto: 'var(--color-cyan)',
  stock: 'var(--color-violet)',
  etf: 'var(--color-warn)',
  index: 'var(--color-blue)',
  future: 'var(--color-magenta)',
  commodity: 'var(--color-pos)',
};

function typeColor(assetType: string): string {
  return TYPE_COLOR[assetType.toLowerCase()] ?? 'var(--color-mut)';
}

export function AddMarketPicker({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  // undefined = lädt noch, null = Laden fehlgeschlagen — ehrlich zeigen, kein leerer Fake
  const [assets, setAssets] = useState<PickerAsset[] | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null); // null = alle Klassen
  const [busyId, setBusyId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void trpc.product.allAssets
      .query()
      .then((rows) => {
        if (!cancelled) setAssets(rows);
      })
      .catch(() => {
        if (!cancelled) setAssets(null);
      });
    // Fokus direkt ins Suchfeld — wer den Picker öffnet, will tippen, nicht erst klicken
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, []);

  // Anlageklassen aus den ECHTEN Daten ableiten — kein hartkodierter Katalog,
  // der bei neuen Klassen im Asset-Register stumm veralten würde.
  const types = useMemo(() => [...new Set((assets ?? []).map((a) => a.assetType))].sort(), [assets]);

  const results = useMemo(() => {
    const base = typeFilter === null ? (assets ?? []) : (assets ?? []).filter((a) => a.assetType === typeFilter);
    return rankAssets(base, query, 30);
  }, [assets, query, typeFilter]);

  async function toggle(asset: PickerAsset) {
    setBusyId(asset.id);
    try {
      const res = await trpc.product.toggleFavorite.mutate({ assetId: asset.id });
      // Lokalen Stern-Zustand nachziehen, damit die Liste sofort die Server-Wahrheit zeigt
      setAssets((prev) => (Array.isArray(prev) ? prev.map((a) => (a.id === asset.id ? { ...a, isFavorite: res.favorite } : a)) : prev));
      onChanged();
    } catch {
      // Toggle fehlgeschlagen → Zustand unverändert lassen (kein falscher Stern)
    } finally {
      setBusyId(null);
    }
  }

  const chip = (active: boolean) => ({
    borderColor: active ? 'rgba(96,165,250,0.6)' : 'var(--color-line)',
    color: active ? 'var(--color-cyan)' : 'var(--color-mut)',
  });

  return (
    <div className="glass reveal mb-5 p-4" style={{ '--stagger': 0.5, borderColor: 'rgba(96,165,250,0.35)' } as React.CSSProperties}>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose(); // gleiche Erwartung wie bei der Command-Palette
          }}
          placeholder={t('dashboard.addMarketSearch')}
          className="field w-full min-w-0 px-3 py-2 text-sm"
        />
        <button
          onClick={onClose}
          className="shrink-0 rounded-[0.625rem] border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
        >
          {t('common.close')}
        </button>
      </div>

      {/* Klassen-Filter: alle Anlageklassen bleiben wählbar („Alle“ = kein Filter) */}
      {types.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button onClick={() => setTypeFilter(null)} className="rounded-full border px-2.5 py-1 text-xs" style={chip(typeFilter === null)}>
            {t('common.all')}
          </button>
          {types.map((ty) => (
            <button key={ty} onClick={() => setTypeFilter(ty)} className="rounded-full border px-2.5 py-1 text-xs" style={chip(typeFilter === ty)}>
              {ty}
            </button>
          ))}
        </div>
      )}

      {assets === undefined ? (
        <p className="mt-4 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('common.loading')}
        </p>
      ) : assets === null ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--color-neg)' }}>
          {t('common.error')}
        </p>
      ) : results.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('palette.empty')}
        </p>
      ) : (
        <ul className="mt-3 max-h-72 overflow-y-auto">
          {results.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => void toggle(a)}
                disabled={busyId !== null}
                title={a.isFavorite ? t('fav.remove') : t('fav.add')}
                className="flex w-full items-center gap-2.5 rounded-[0.625rem] px-2 py-2 text-left transition-colors hover:bg-[rgba(59,130,246,0.12)] disabled:opacity-60"
              >
                <span
                  className="shrink-0 text-base leading-none"
                  style={{ color: a.isFavorite ? 'var(--color-warn)' : 'rgba(139,148,184,0.45)' }}
                >
                  {busyId === a.id ? '…' : a.isFavorite ? '★' : '☆'}
                </span>
                <span className="num w-16 shrink-0 truncate font-medium">{a.ticker}</span>
                <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--color-mut)' }}>
                  {a.name}
                </span>
                <span
                  className="label shrink-0 rounded border px-1.5 py-0.5"
                  style={{ borderColor: 'var(--color-line)', color: typeColor(a.assetType) }}
                >
                  {a.assetType}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Klartext statt Rätselraten: was der Stern hier konkret bewirkt (Patrick: klare Beschriftung) */}
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('dashboard.addMarketHint')}
      </p>
    </div>
  );
}
