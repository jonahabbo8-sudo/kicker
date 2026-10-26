/* Kicker — service worker : rend l'app installable et l'ouvre même avec un réseau faible.
   Les pages passent toujours d'abord par le réseau, pour toujours avoir la dernière version. */
const CACHE = "kicker-v3";
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/", "/manifest.json", "/icon-192.png", "/apple-touch-icon.png", "/supabase-2.118.0.js", "/montserrat.woff2", "/montserrat-italic.woff2"])).catch(() => {}));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  if (r.mode === "navigate") {
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put("/", cp)); return res; })
      .catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r)));
});

/* Notifications : rappels de soirée, invitations, remboursements */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Kicker", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || undefined, data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).origin === self.location.origin);
    if (c) { c.postMessage({ type: "open", url }); return c.focus(); }
    return clients.openWindow(url);
  }));
});
