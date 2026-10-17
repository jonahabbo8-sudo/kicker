/* Kicker — service worker : rend l'app installable et l'ouvre même avec un réseau faible.
   Les pages passent toujours d'abord par le réseau, pour toujours avoir la dernière version. */
const CACHE = "kicker-v1";
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/", "/manifest.json", "/icon-192.png", "/apple-touch-icon.png"])).catch(() => {}));
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
