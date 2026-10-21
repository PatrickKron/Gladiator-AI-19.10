import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

/**
 * Asset-Selektor (Patrick-Lücke 2): Scan-Universum (Basis + ★ Favoriten) als
 * Dropdown, Auswahl in localStorage — Oracle/Aegis beziehen sich darauf.
 */

const STORAGE_KEY = 'gladiator.selectedAsset';

export function getSelectedAsset(): string {
  return localStorage.getItem(STORAGE_KEY) ?? 'BTC/USDT';
}

/** Ausgewähltes Asset persistieren (z. B. beim Deep-Link-Sprung in Charts). */
export function setSelectedAsset(symbol: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, symbol.toUpperCase());
  } catch {
    /* localStorage nicht verfügbar — ignorieren */
  }
}

export function AssetSelect({ value, onChange, persist = true, label }: { value: string; onChange: (symbol: string) => void; /** false = Zelle eines Mehrfach-Layouts: Wahl nicht als Seiten-Asset merken */ persist?: boolean; label?: string }) {
  const { t } = useTranslation();
  const [universe, setUniverse] = useState<string[]>([value]);

  useEffect(() => {
    void trpc.market.scanUniverse
      .query()
      .then((u) => setUniverse(u.includes(value) ? u : [...u, value]))
      .catch(() => setUniverse([value]));
  }, []);

  return (
    <label className="flex items-center gap-2">
      <span className="label">{label ?? t('assetCtx.selector')}</span>
      <select
        value={value}
        onChange={(e) => {
          if (persist) localStorage.setItem(STORAGE_KEY, e.target.value);
          onChange(e.target.value);
        }}
        className="field num cursor-pointer px-3 py-1.5 text-sm"
        style={{ color: 'var(--color-cyan)' }}
      >
        {universe.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}
