import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getEffectPrefs, onEffectPrefs, onRainBurst, rainIntensity, SCREENSAVER_AFTER_MS, type EffectPrefs, type RainBurst } from '../lib/effects.js';
import { useIdle } from '../lib/idle.js';
import { getLatest, onTick, type TickWithDirection } from '../lib/prices.js';
import { appLocale } from '../lib/locale.js';
import { MatrixRain } from './MatrixRain.js';

/**
 * Entscheidet, wann der Daten-Regen sichtbar ist (lib/effects.ts) und zeigt
 * den Bildschirmschoner: Uhrzeit, Favoriten-Kurse aus echten Ticks, ein Satz
 * zum Fortsetzen. Jede Eingabe holt die Oberfläche zurück (useIdle).
 */
export function RainLayer({ authenticated }: { authenticated: boolean }) {
  const [prefs, setPrefs] = useState<EffectPrefs>(() => getEffectPrefs());
  const [burst, setBurst] = useState<RainBurst | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const idle = useIdle(SCREENSAVER_AFTER_MS, authenticated && prefs.screensaver);

  useEffect(() => onEffectPrefs(setPrefs), []);
  useEffect(() => onRainBurst((b) => setBurst((prev) => (prev && prev.until > b.until ? prev : b))), []);

  // Während eines Impulses die Uhr laufen lassen (Anstieg/Abklingen), sonst still.
  useEffect(() => {
    if (!burst) return;
    let raf = 0;
    const tick = () => {
      const t = performance.now();
      setNow(t);
      if (t < burst.until) raf = requestAnimationFrame(tick);
      else setBurst(null);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [burst]);

  const state = rainIntensity({ prefs, authenticated, idle, burst, now });
  const saver = authenticated && idle && prefs.screensaver;

  return (
    <>
      <MatrixRain intensity={state.intensity} tone={state.tone ?? 'accent'} focusSymbol={state.symbol} />
      {saver && <Screensaver />}
    </>
  );
}

function Screensaver() {
  const { t } = useTranslation();
  const [clock, setClock] = useState(() => new Date());
  const [ticks, setTicks] = useState<TickWithDirection[]>(() => getLatest());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    const off = onTick(() => setTicks(getLatest()));
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, []);
  const locale = appLocale();
  return (
    <div className="screensaver" role="presentation">
      <p className="wordmark text-sm" style={{ color: 'var(--color-mut)' }}>
        GLADIATOR
      </p>
      <p className="num text-6xl font-bold tracking-tight">{clock.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</p>
      {ticks.length > 0 && (
        <div className="num flex flex-wrap justify-center gap-x-6 gap-y-1 text-sm" style={{ color: 'var(--color-mut)' }}>
          {ticks.map((x) => (
            <span key={x.symbol}>
              {x.symbol.replace('/USDT', '')}{' '}
              <span style={{ color: 'var(--color-ink)' }}>{x.price.toLocaleString(locale, { maximumFractionDigits: x.price >= 1000 ? 0 : 2 })} $</span>
              {x.changePct24h != null && (
                <span style={{ color: x.changePct24h >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                  {' '}
                  {x.changePct24h >= 0 ? '+' : ''}
                  {x.changePct24h.toFixed(2)} %
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      <p className="mt-6 text-xs" style={{ color: 'var(--color-mut)' }}>
        {t('effects.saverHint')}
      </p>
    </div>
  );
}
