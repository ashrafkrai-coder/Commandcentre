// Service worker Command Centre
// Tukar VERSI setiap kali fail PWA dikemas kini supaya peranti ambil versi baru.
const VERSI = "cc-v30";
const FAIL = [
  "./",
  "index.html",
  "config.js",
  "app-engine.js",
  "master-index.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSI).then(c => c.addAll(FAIL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSI).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Data Apps Script: sentiasa terus ke rangkaian (data terakhir disimpan oleh halaman)
  if (url.hostname.endsWith("script.google.com") || url.hostname.endsWith("googleusercontent.com")) return;

  // Font Google: guna cache dahulu
  if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.open(VERSI).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { c.put(req, res.clone()); return res; })))
    );
    return;
  }

  // master-index.json: Stale-While-Revalidate (papar cache dahulu, kemas kini senyap di latar)
  if (url.origin === self.location.origin && url.pathname.endsWith("/master-index.json")) {
    e.respondWith(
      caches.open(VERSI).then(c => c.match(req).then(hit => {
        const baru = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || baru;
      }))
    );
    return;
  }

  // Aset statik (ikon, imej, CSS, manifest): Cache-First
  if (url.origin === self.location.origin && /\.(png|jpe?g|svg|webp|ico|css|woff2?|webmanifest)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSI).then(c => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Fail aplikasi (HTML/JS): rangkaian dahulu, jatuh ke cache bila luar talian
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(VERSI).then(c => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then(hit => hit || caches.match("index.html")))
    );
  }
});
