import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { getAccessToken, onAuthChange, refreshSession } from './api.js';
import { setDemoMode } from './lib/demo-mode.js';
import { MatrixRain } from './components/MatrixRain.js';
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
const Trading = lazyView(() => import('./views/Trading.js'), 'Trading');
const AssetDetail = lazyView(() => import('./views/AssetDetail.js'), 'AssetDetail');
const Pakete = lazyView(() => import('./views/Pakete.js'), 'Pakete');
const Magazine = lazyView(() => import('./views/Magazine.js'), 'Magazine');
const Kalender = lazyView(() => import('./views/Kalender.js'), 'Kalender');
const Agenten = lazyView(() => import('./views/Agenten.js'), 'Agenten');
const Werkstatt = lazyView(() => import('./views/Werkstatt.js'), 'Werkstatt');
const Strategien = lazyView(() => import('./views/Strategien.js'), 'Strategien');
const Workshop = lazyView(() => import('./views/Workshop.js'), 'Workshop');
const Intelligenz = lazyView(() => import('./views/Intelligenz.js'), 'Intelligenz');
const Einstellungen = lazyView(() => import('./views/Einstellungen.js'), 'Einstellungen');
const Profil = lazyView(() => import('./views/Profil.js'), 'Profil');
const Vermoegen = lazyView(() => import('./views/Vermoegen.js'), 'Vermoegen');

type AuthState = 'restoring' | 'anonymous' | 'authenticated';

/** Leitet Alt-Routen auf die zusammengeführte Asset-Detailseite um (P2.9). */
function Redirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.hash = to;
  }, [to]);
  return null;
}

/**
 * Direkteinstieg „Demo-Trading" (Sidebar): schaltet den Demo-Modus ein und
 * landet auf der Trading-Seite — dort rendert der aktive Demo-Modus das
 * Demo-Konto. Eigener Sidebar-Eintrag, damit das Feature auffindbar ist.
 */
function DemoEntry() {
  useEffect(() => {
    setDemoMode(true);
    window.location.hash = '#/trading';
  }, []);
  return null;
}

const ROUTES: Record<string, ComponentType> = {
  '#/': Dashboard,
  '#/signals': Signals,
  '#/labor': Labor,
  '#/trading': Trading,
  '#/demo': DemoEntry,
  '#/charts': AssetDetail,
  '#/pakete': Pakete,
  '#/oracle': () => <Redirect to="#/charts?tab=makro" />,
  '#/magazine': Magazine,
  '#/kalender': Kalender,
  '#/aegis': () => <Redirect to="#/charts?tab=risiko" />,
  '#/agenten': Agenten,
  '#/werkstatt': Werkstatt,
  '#/strategien': Strategien,
  '#/strategie-workshop': Workshop,
  '#/intelligenz': Intelligenz,
  // Alt-Routen der drei Einzelseiten → Intelligenz-Hub (Bookmarks bleiben gültig)
  '#/ml': () => <Redirect to="#/intelligenz?tab=ml" />,
  '#/rl-agenten': () => <Redirect to="#/intelligenz?tab=rl" />,
  '#/performance': () => <Redirect to="#/intelligenz?tab=performance" />,
  '#/einstellungen': Einstellungen,
  '#/profil': Profil,
  '#/vermoegen': Vermoegen,
};

export function App() {
  const { t } = useTranslation();
  const [auth, setAuth] = useState<AuthState>('restoring');
  const [route, setRoute] = useState(window.location.hash || '#/');

  useEffect(() => {
    const off = onAuthChange((authed) => setAuth(authed ? 'authenticated' : 'anonymous'));
    const onHash = () => setRoute(window.location.hash || '#/');
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
  const Page = ROUTES[clean === '' || clean === '#' ? '#/' : clean] ?? Dashboard;

  return (
    <>
      {/* Hintergrund: zwei Lichtwelten + Daten-Rain aus echten Ticks */}
      <div className="ambient" />
      <MatrixRain />

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
