/* Service worker Moldovagaz: primește notificările push (probleme: contoare care nu mai transmit, antene) și le arată, chiar dacă aplicația e închisă.
   Nu păstrează nimic în cache (datele sunt interne și se cer mereu proaspete). Sunetul: notificarea folosește sunetul implicit al telefonului / calculatorului;
   dacă aplicația e deschisă, ea însăși redă și un sunet propriu (mesajul „push” de mai jos). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Moldovagaz", body: event.data ? event.data.text() : "" }; }
  const title = d.title || "Moldovagaz";
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: d.tag || "moldovagaz",
      renotify: true,
      silent: false,
      requireInteraction: d.level === "crit",
      vibrate: [220, 110, 220, 110, 320],
      timestamp: Date.now(),
      data: { url: d.url || "/notificari" },
    });
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "push", level: d.level || "warn", tag: d.tag || "" });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/notificari";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && "focus" in w) {
        try { await w.navigate(url); } catch { /* alt browser */ }
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
