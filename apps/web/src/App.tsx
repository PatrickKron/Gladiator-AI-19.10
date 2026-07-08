import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { getAccessToken, onAuthChange, refreshSession } from './api.js';
import { MatrixRain } from './components/MatrixRain.js';
import { Shell } from './components/Shell.js';
import { Login } from './views/Login.js';

/**
 * Router (Hash-basiert) + Code-Splitting (P2.13): jede Seite wird lazy geladen,
 * damit der initiale Bundle klein bleibt. Named Exports → { default } mappen.
 */
const lazyView = <T extends string>(load: () => Promise<Record<T, ComponentType>>, name: T) =>
  lazy(() => load().then((m) => ({ default: m[name] })));

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

type AuthState = 'restoring' | 'anonymous' | 'authenticated';

/** Leitet Alt-Routen auf die zusammengeführte Asset-Detailseite um (P2.9). */
function Redirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.hash = to;
  }, [to]);
  return null;
}

const ROUTES: Record<string, ComponentType> = {
  '#/': Dashboard,
  '#/signals': Signals,
  '#/labor': Labor,
  '#/trading': Trading,
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
