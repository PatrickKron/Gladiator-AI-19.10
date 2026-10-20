import { trpc } from '../api.js';

/**
 * Web-Push auf diesem Gerät (Vision-Punkt 3): Service Worker registrieren,
 * Erlaubnis holen, Abo beim Server hinterlegen. Ohne Browser-Unterstützung oder
 * ohne VAPID-Schlüssel auf dem Server ehrlich „nicht verfügbar“.
 */

/** VAPID-Public-Key (URL-sicheres Base64) → Bytes für pushManager.subscribe. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js');
}

/** Abo dieses Geräts (oder null). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  return reg ? reg.pushManager.getSubscription() : null;
}

export type EnableResult = 'enabled' | 'denied' | 'unsupported';

export async function enablePush(publicKey: string): Promise<EnableResult> {
  if (!pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource }));
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('Push-Abo unvollständig.');
  await trpc.notifications.subscribe.mutate({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: navigator.userAgent.slice(0, 300),
  });
  return 'enabled';
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await trpc.notifications.unsubscribe.mutate({ endpoint: sub.endpoint });
  await sub.unsubscribe();
}
