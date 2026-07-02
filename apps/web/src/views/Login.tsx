import { useState, type FormEvent } from 'react';
import { login } from '../api.js';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-[0.25em]">GLADIATOR</h1>
          <p className="mt-1 text-sm text-mut">
            v2 ·{' '}
            <span className="rounded border border-warn/50 px-1.5 py-0.5 text-xs text-warn">ROHBAU</span>
          </p>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl border border-line bg-panel p-6">
          <label className="block text-sm text-mut" htmlFor="email">
            E-Mail
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2 outline-none focus:border-acc"
          />
          <label className="mt-4 block text-sm text-mut" htmlFor="password">
            Passwort
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2 outline-none focus:border-acc"
          />

          {error && <p className="mt-4 text-sm text-neg">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-6 w-full rounded-lg bg-acc px-4 py-2 font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Anmelden …' : 'Anmelden'}
          </button>

          <p className="mt-4 text-center text-xs text-mut">
            Dein v1-Login funktioniert weiter (gleiche E-Mail, gleiches Passwort).
          </p>
        </form>
      </div>
    </div>
  );
}
