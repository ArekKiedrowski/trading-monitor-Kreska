const CACHE = "trading-monitor-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request);
    })
  );
});

self.addEventListener("message", event => {
  if (!event.data || event.data.type !== "NOTIFY") return;

  const { title, body, tag, urgent } = event.data;

  event.waitUntil(
    self.registration.showNotification(title || "Trading Monitor", {
      body: body || "",
      tag: tag || "signal",
      icon: "./icon.svg",
      badge: "./icon.svg",
      vibrate: urgent ? [200, 100, 200, 100, 200] : [200],
      requireInteraction: !!urgent,
      actions: urgent ? [{ action: "open", title: "Otwórz XTB" }] : []
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  event.waitUntil(
    event.action === "open"
      ? clients.openWindow("https://xstation5.xtb.com/")
      : clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
          if (clientList.length) return clientList[0].focus();
          return clients.openWindow("./");
        })
  );
});
