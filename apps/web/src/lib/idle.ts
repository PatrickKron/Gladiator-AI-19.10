import { useEffect, useState } from 'react';

/**
 * Ruhe-Erkennung für den Bildschirmschoner: ohne Maus, Tastatur, Berührung
 * oder Scrollen für `afterMs` gilt die Oberfläche als ruhend. Ein verborgener
 * Tab schläft nie (nichts zu zeigen), eingeschränkte Bewegung ebenfalls nicht.
 */

export function isIdle(lastActivity: number, now: number, afterMs: number, hidden: boolean): boolean {
  if (hidden) return false;
  return now - lastActivity >= afterMs;
}

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

export function useIdle(afterMs: number, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setIdle(false);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setIdle(false);
      return;
    }
    let last = Date.now();
    const wake = () => {
      last = Date.now();
      setIdle(false);
    };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, wake, { passive: true });
    document.addEventListener('visibilitychange', wake);
    const timer = window.setInterval(() => {
      setIdle(isIdle(last, Date.now(), afterMs, document.hidden));
    }, 5_000);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, wake);
      document.removeEventListener('visibilitychange', wake);
      window.clearInterval(timer);
    };
  }, [afterMs, enabled]);
  return idle;
}
