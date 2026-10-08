// Network first, so the dictionary is always current online; the last copy is
// served from the cache when offline.
const CACHE = "vazhe-v3";
const SHELL = ["./", "index.html", "styles.css", "app.js", "drag.js", "icons.svg", "manifest.webmanifest",
  "fonts/geist.woff2", "fonts/geist-italic.woff2", "fonts/vazirmatn.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  // Who is signed in is always asked from the server, never from the cache.
  if (url.pathname.includes("/api/auth/")) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
