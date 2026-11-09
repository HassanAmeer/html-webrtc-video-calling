/* WeMeet — incoming call push notifications (Web Push service worker) */
// Activate immediately and take control of open pages so a freshly deployed
// worker can receive pushes without waiting for every tab to be closed.
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

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

// Chrome can silently rotate a push subscription. Ask an open page to
// re-register it so call notifications keep arriving.
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      list.forEach(function (client) {
        try { client.postMessage({ type: "push-subscription-changed" }); } catch (e) { /* ignore */ }
      });
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
            // Deep-link an already-open tab to the caller's uid so tapping the
            // notification always lands on the right call screen.
            var sameOrigin = false;
            try { sameOrigin = (new URL(c.url)).origin === self.location.origin; } catch (e2) { sameOrigin = false; }
            if (sameOrigin && target && target !== "/" && typeof c.navigate === "function") {
              var already = false;
              try { already = new URL(c.url).search === new URL(target, self.location.origin).search; } catch (e3) { already = false; }
              if (!already) {
                return c.navigate(target).then(function (cl) {
                  return (cl && cl.focus) ? cl.focus() : cl;
                }).catch(function () { return c.focus(); });
              }
            }
            return c.focus();
          } catch (e) { /* fall through */ }
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
