import { useEffect, useRef, useState, type FormEvent } from 'react';
import { login } from '../api.js';
import { PlexusHero } from '../components/PlexusHero.js';

const SCRAMBLE = '█▓▒░<>/\\|01ΞΛΔ$#%&';
const TARGET = 'ZUGRIFF GEWÄHRT';

/**
 * Login als „Dekryptierungs-Moment": nach erfolgreichem Login scrambelt die
 * Wortmarke kurz zu „ZUGRIFF GEWÄHRT", dann übernimmt das Dashboard.
 * (Der Erfolg ist ECHT — die Animation läuft erst nach bestätigter Auth.)
 */
export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const raf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  function runDecryption(onDone: () => void) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDecrypted(TARGET);
      window.setTimeout(onDone, 150);
      return;
    }
    const start = performance.now();
    const DURATION = 650;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION);
      const solved = Math.floor(p * TARGET.length);
      const text = TARGET.split('')
        .map((c, i) =>
          i < solved || c === ' ' ? c : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)],
        )
        .join('');
      setDecrypted(text);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else window.setTimeout(onDone, 250);
    };
    raf.current = requestAnimationFrame(tick);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // login() setzt die Session global — App wechselt durch onAuthChange.
      // Wir verzögern das nur um den Dekryptierungs-Moment (die Auth selbst ist längst echt).
      await login(email, password);
      runDecryption(() => {});
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen.');
    }
  }

  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
      {/* Hero-Konstellation: füllt die Bühne hinter Wortmarke + Karte (pulst auf echte Ticks) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <PlexusHero density={30} className="opacity-70" />
      </div>
      <div className="relative w-full max-w-sm">
        <div className="reveal mb-10 text-center" style={{ '--stagger': 0 } as React.CSSProperties}>
          <h1 className="wordmark text-3xl font-bold">
            {decrypted ?? 'GLADIATOR'}
          </h1>
          <p className="label mt-3">
            Trading Command Center ·{' '}
            <span className="rounded border border-warn/40 px-1.5 py-0.5 text-warn">Rohbau</span>
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="glass reveal p-7"
          style={{ '--stagger': 2 } as React.CSSProperties}
        >
          <label className="label" htmlFor="email">
            E-Mail
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field mt-1.5 w-full px-3.5 py-2.5 text-[15px]"
          />
          <label className="label mt-5 block" htmlFor="password">
            Passwort
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field mt-1.5 w-full px-3.5 py-2.5 text-[15px]"
          />

          {error && <p className="mt-4 text-sm" style={{ color: 'var(--color-neg)' }}>{error}</p>}

          <button type="submit" disabled={busy} className="btn-primary mt-7 w-full px-4 py-2.5">
            {decrypted ? 'Entschlüssele …' : busy ? 'Prüfe Zugang …' : 'Anmelden'}
          </button>

          <p className="mt-5 text-center text-xs" style={{ color: 'var(--color-mut)' }}>
            Dein v1-Login gilt weiter — gleiche E-Mail, gleiches Passwort.
          </p>
        </form>

        <p className="reveal mt-6 text-center text-xs" style={{ color: 'var(--color-mut)', '--stagger': 4 } as React.CSSProperties}>
          Der Regen im Hintergrund besteht aus echten Live-Marktdaten.
        </p>
      </div>
    </div>
  );
}
