/* WeMeet — incoming call push notifications (Web Push service worker) */
self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { title: String(event.data) }; } catch (_) { data = { title: "Bot is thinking" }; }
  }
  var title = data.title || "Bot is thinking";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/images/fav.png",
      badge: "/images/fav.png",
      tag: "incoming-call",
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400],
      data: { url: data.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification && event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (all) {
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (c && "focus" in c) {
          try {
            return c.focus();
          } catch (e) { /* fall through */ }
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
