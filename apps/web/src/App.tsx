import { useEffect, useState } from 'react';
import { getAccessToken, onAuthChange, refreshSession } from './api.js';
import { MatrixRain } from './components/MatrixRain.js';
import { Login } from './views/Login.js';
import { Dashboard } from './views/Dashboard.js';

type AuthState = 'restoring' | 'anonymous' | 'authenticated';

export function App() {
  const [auth, setAuth] = useState<AuthState>('restoring');

  useEffect(() => {
    const off = onAuthChange((authed) => setAuth(authed ? 'authenticated' : 'anonymous'));
    void refreshSession().then((ok) => {
      if (!ok && getAccessToken() === null) setAuth('anonymous');
    });
    return off;
  }, []);

  return (
    <>
      {/* Hintergrund: eine Lichtquelle + Daten-Rain aus echten Ticks */}
      <div className="ambient" />
      <MatrixRain />

      {auth === 'restoring' ? (
        <div className="relative z-10 flex min-h-screen items-center justify-center">
          <p className="label animate-pulse">Sitzung wird wiederhergestellt …</p>
        </div>
      ) : auth === 'authenticated' ? (
        <Dashboard />
      ) : (
        <Login />
      )}
    </>
  );
}
