import { useEffect, useState } from 'react';
import { getAccessToken, onAuthChange, refreshSession } from './api.js';
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

  if (auth === 'restoring') {
    return (
      <div className="flex min-h-screen items-center justify-center text-mut">
        Sitzung wird wiederhergestellt …
      </div>
    );
  }
  return auth === 'authenticated' ? <Dashboard /> : <Login />;
}
