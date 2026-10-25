import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { getAccessToken, onAuthChange, refreshSession } from './api.js';
import { resolveRedirect, type PageHash } from './lib/navigation.js';
import { RainLayer } from './components/RainLayer.js';
import { Shell } from './components/Shell.js';
import { Login } from './views/Login.js';

/**
 * Router (Hash-basiert) + Code-Splitting (P2.13): jede Seite wird lazy geladen,
 * damit der initiale Bundle klein bleibt. Named Exports → { default } mappen.
 *
 * Selbstheilung nach Deploys: Ein Rebuild ändert die Chunk-Hashes — ein Tab,
 * der noch die alte index.html hält, findet seine Seiten-Chunks nicht mehr
 * („Failed to fetch dynamically imported module", live beobachtet: schwarze
 * Seite). Dann EINMAL hart neu laden (Session-Flag verhindert Reload-Schleifen
 * bei echten Netzfehlern).
 */
const CHUNK_RELOAD_KEY = 'gladiator.chunkReloaded';
const lazyView = <T extends string>(load: () => Promise<Record<T, ComponentType>>, name: T) =>
  lazy(() =>
    load()
      .then((m) => {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        return { default: m[name] };
      })
      .catch((err: unknown) => {
        if (sessionStorage.getItem(CHUNK_RELOAD_KEY) !== '1') {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
          window.location.reload();
          return new Promise<{ default: ComponentType }>(() => {}); // Seite lädt neu
        }
        throw err;
      }),
  );

const Dashboard = lazyView(() => import('./views/Dashboard.js'), 'Dashboard');
const Signals = lazyView(() => import('./views/Signals.js'), 'Signals');
const Labor = lazyView(() => import('./views/Labor.js'), 'Labor');
const AssetDetail = lazyView(() => import('./views/AssetDetail.js'), 'AssetDetail');
const Pakete = lazyView(() => import('./views/Pakete.js'), 'Pakete');
const Magazine = lazyView(() => import('./views/Magazine.js'), 'Magazine');
const Kalender = lazyView(() => import('./views/Kalender.js'), 'Kalender');
const Agenten = lazyView(() => import('./views/Agenten.js'), 'Agenten');
const Strategien = lazyView(() => import('./views/Strategien.js'), 'Strategien');
const Intelligenz = lazyView(() => import('./views/Intelligenz.js'), 'Intelligenz');
const Einstellungen = lazyView(() => import('./views/Einstellungen.js'), 'Einstellungen');
const Profil = lazyView(() => import('./views/Profil.js'), 'Profil');
const Vermoegen = lazyView(() => import('./views/Vermoegen.js'), 'Vermoegen');
const EchtesGeld = lazyView(() => import('./views/EchtesGeld.js'), 'EchtesGeld');

const Marktlage = lazyView(() => import('./views/Marktlage.js'), 'Marktlage');
const Funktionen = lazyView(() => import('./views/Funktionen.js'), 'Funktionen');
const Protokoll = lazyView(() => import('./views/Protokoll.js'), 'Protokoll');
const Traden = lazyView(() => import('./views/Traden.js'), 'Traden');
const Screener = lazyView(() => import('./views/Screener.js'), 'Screener');
const Heatmap = lazyView(() => import('./views/Heatmap.js'), 'Heatmap');

type AuthState = 'restoring' | 'anonymous' | 'authenticated';

/**
 * Hash → View. Die Seiten selbst (Name, Bereich, Tabs, Suchbegriffe) stehen in
 * der Funktions-Registry (lib/navigation.ts); `satisfies Record<PageHash, …>`
 * lässt den Build scheitern, wenn eine Registry-Seite keine View hat.
 * Alte Links (Oracle, Aegis, ML/RL-Einzelseiten, Asset-Makro/Risiko) leitet
 * resolveRedirect() zentral um — Bookmarks bleiben gültig.
 */
const ROUTES = {
  '#/': Dashboard,
  '#/charts': AssetDetail,
  '#/screener': Screener,
  '#/signals': Signals,
  '#/marktlage': Marktlage,
  '#/pakete': Pakete,
  '#/heatmap': Heatmap,
  '#/kalender': Kalender,
  '#/magazine': Magazine,
  '#/traden': Traden,
  '#/vermoegen': Vermoegen,
  '#/echtes-geld': EchtesGeld,
  '#/agenten': Agenten,
  '#/strategien': Strategien,
  '#/labor': Labor,
  '#/intelligenz': Intelligenz,
  '#/einstellungen': Einstellungen,
  '#/profil': Profil,
  '#/protokoll': Protokoll,
  '#/funktionen': Funktionen,
} satisfies Record<PageHash, ComponentType>;

export function App() {
  const { t } = useTranslation();
  const [auth, setAuth] = useState<AuthState>('restoring');
  const [route, setRoute] = useState(window.location.hash || '#/');

  useEffect(() => {
    const off = onAuthChange((authed) => setAuth(authed ? 'authenticated' : 'anonymous'));
    const onHash = () => {
      const target = resolveRedirect(window.location.hash);
      if (target) {
        window.history.replaceState(null, '', target);
      }
      setRoute(window.location.hash || '#/');
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    void refreshSession().then((outcome) => {
      if (outcome !== 'ok' && getAccessToken() === null) setAuth('anonymous');
    });
    return () => {
      off();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  const clean = route.split('?')[0] || '#/';
  const Page = (ROUTES as Record<string, ComponentType>)[clean === '' || clean === '#' ? '#/' : clean] ?? Dashboard;

  return (
    <>
      {/* Hintergrund (v2-Optik): zwei Lichtwelten + Daten-Regen aus echten Ticks (lib/effects.ts, Dauer-Regen Standard an) */}
      <div className="ambient" aria-hidden="true" />
      <RainLayer authenticated={auth === 'authenticated'} />

      {auth === 'restoring' ? (
        <div className="relative z-10 flex min-h-screen items-center justify-center">
          <p className="label animate-pulse">{t('common.restoring')}</p>
        </div>
      ) : auth === 'authenticated' ? (
        <Shell route={route}>
          <Suspense
            fallback={
              <div className="glass p-6">
                <p className="label animate-pulse">{t('common.loading')}</p>
              </div>
            }
          >
            <Page />
          </Suspense>
        </Shell>
      ) : (
        <Login />
      )}
    </>
  );
}
