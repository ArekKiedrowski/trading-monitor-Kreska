const CACHE = 'trading-monitor-v1';
const ASSETS = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'NOTIFY') {
    const {title, body, tag, urgent} = e.data;
    self.registration.showNotification(title, {
      body,
      tag: tag || 'signal',
      icon: '/icon.png',
      badge: '/icon.png',
      vibrate: urgent ? [200, 100, 200, 100, 200] : [200],
      requireInteraction: urgent || false,
      actions: urgent ? [{action: 'open', title: 'Otwórz XTB'}] : []
    });
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'open') {
    clients.openWindow('https://xstation5.xtb.com/');
  } else {
    clients.matchAll({type:'window'}).then(cs => {
      if (cs.length) cs[0].focus();
      else clients.openWindow('/');
    });
  }
});
