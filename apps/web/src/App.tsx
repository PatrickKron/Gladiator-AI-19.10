import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAccessToken, onAuthChange, refreshSession } from './api.js';
import { MatrixRain } from './components/MatrixRain.js';
import { Shell } from './components/Shell.js';
import { Login } from './views/Login.js';
import { Dashboard } from './views/Dashboard.js';
import { Signals } from './views/Signals.js';
import { Labor } from './views/Labor.js';
import { Trading } from './views/Trading.js';
import { Pakete } from './views/Pakete.js';
import { Oracle } from './views/Oracle.js';
import { Magazine } from './views/Magazine.js';
import { Kalender } from './views/Kalender.js';
import { Aegis } from './views/Aegis.js';
import { Agenten } from './views/Agenten.js';
import { Strategien } from './views/Strategien.js';
import { Einstellungen } from './views/Einstellungen.js';
import { Profil } from './views/Profil.js';

type AuthState = 'restoring' | 'anonymous' | 'authenticated';

const ROUTES: Record<string, () => React.JSX.Element> = {
  '#/': Dashboard,
  '#/signals': Signals,
  '#/labor': Labor,
  '#/trading': Trading,
  '#/pakete': Pakete,
  '#/oracle': Oracle,
  '#/magazine': Magazine,
  '#/kalender': Kalender,
  '#/aegis': Aegis,
  '#/agenten': Agenten,
  '#/strategien': Strategien,
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
          <Page />
        </Shell>
      ) : (
        <Login />
      )}
    </>
  );
}
