// Service Worker — INVB - Chat
// Propósito: viabilizar a instalação como PWA.
// O app depende de Firebase (sempre online), então o SW não faz cache agressivo.

const CACHE_NAME = 'nvb-chat-v2';

// Instala e ativa imediatamente
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

// Toque na notificação: voltar ao chat (Android / desktop)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const c of clientList) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// Estratégia network-first: tenta rede, fallback para cache só em recursos estáticos
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Ignora requisições Firebase / externas — essas nunca são cacheadas
  if (!url.origin.includes(self.location.hostname)) return;

  // Desenvolvimento local: nunca serve JS/CSS do cache (senão o Vite mostra código antigo)
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;

  // Para recursos estáticos (JS, CSS, imagens, fontes): cache-first
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font'
  ) {
    e.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Para o documento HTML: network-first (sempre reflete o deploy mais recente)
  if (request.destination === 'document') {
    e.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
  }
});
