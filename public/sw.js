/* מוקד אחזקה — service worker: מאפשר התקנה כאפליקציה (הוספה למסך הבית) והתראות דחיפה */
"use strict";

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

/* אין קאשינג של תוכן — זו אפליקציה חיה שתמיד צריכה נתונים עדכניים מהשרת.
   ה-service worker קיים כאן בעיקר כדי לאפשר התקנה (PWA) והתראות דחיפה. */
self.addEventListener("fetch", () => { /* pass-through (no offline cache) */ });

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: "מוקד אחזקה", body: (event.data && event.data.text()) || "" };
  }
  const title = data.title || "מוקד אחזקה";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    vibrate: [200, 100, 200, 100, 200],
    dir: "rtl",
    lang: "he",
    tag: data.tag || "moked-achzaka",
    renotify: true,
    data: { url: data.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate(targetUrl); return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
