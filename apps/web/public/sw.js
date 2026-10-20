/* global self, URL */
/* Gladiator Service Worker — NUR Web-Push (Vision-Punkt 3). Bewusst kein
   fetch-Handler/Caching: die App lädt immer frisch vom eigenen Server. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Gladiator', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Gladiator';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.id || undefined,
      requireInteraction: data.severity === 'critical',
      data: { link: data.link || '#/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '#/';
  const target = new URL('/' + (link.startsWith('#') ? link : '#/'), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin)) {
          w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
