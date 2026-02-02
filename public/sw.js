// Service Worker for Claude Web Push Notifications

const CACHE_NAME = "claude-web-v1";
const NOTIFICATION_DB = "claude-notifications";
const NOTIFICATION_STORE = "flags";

// IndexedDB helper functions
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NOTIFICATION_DB, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(NOTIFICATION_STORE)) {
        db.createObjectStore(NOTIFICATION_STORE);
      }
    };
  });
}

async function setNotificationFlag(sessionId, timestamp) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTIFICATION_STORE, "readwrite");
    const store = tx.objectStore(NOTIFICATION_STORE);
    store.put({ timestamp, notified: true }, sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Handle push events
self.addEventListener("push", async (event) => {
  console.log("[SW] Push received:", event);

  let data = { title: "Claude Web", body: "Response complete" };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || "Response complete",
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%231a1a2e' width='100' height='100' rx='20'/><text x='50' y='65' text-anchor='middle' font-size='50' fill='%23e94560'>C</text></svg>",
    badge:
      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23e94560' width='100' height='100' rx='20'/><text x='50' y='65' text-anchor='middle' font-size='50' fill='white'>C</text></svg>",
    vibrate: [100, 50, 100],
    tag: "claude-response",
    renotify: true,
    requireInteraction: false,
    data: {
      sessionId: data.sessionId,
      timestamp: Date.now(),
      url: data.url || "/",
    },
  };

  // Store flag to prevent double-play sound in client
  if (data.sessionId) {
    try {
      await setNotificationFlag(data.sessionId, Date.now());
    } catch (e) {
      console.error("[SW] Failed to set notification flag:", e);
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Claude Web", options),
  );
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
  console.log("[SW] Notification clicked:", event);

  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // If already open, focus it
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise open new window
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      }),
  );
});

// Handle notification close
self.addEventListener("notificationclose", (event) => {
  console.log("[SW] Notification closed:", event);
});

// Install event
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker");
  self.skipWaiting();
});

// Activate event
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker");
  event.waitUntil(clients.claim());
});

// Message from client (for playing sound from SW context if needed)
self.addEventListener("message", (event) => {
  // Validate message origin - only accept messages from same origin
  if (!event.source || !event.source.url?.startsWith(self.location.origin)) {
    console.warn("[SW] Rejected message from untrusted origin");
    return;
  }

  if (event.data?.type === "CHECK_NOTIFICATION_FLAG") {
    // Client is checking if we already showed a notification
    event.waitUntil(
      (async () => {
        try {
          const db = await openDB();
          const tx = db.transaction(NOTIFICATION_STORE, "readonly");
          const store = tx.objectStore(NOTIFICATION_STORE);
          const request = store.get(event.data.sessionId);

          return new Promise((resolve) => {
            request.onsuccess = () => {
              const flag = request.result;
              event.source.postMessage({
                type: "NOTIFICATION_FLAG_RESULT",
                sessionId: event.data.sessionId,
                wasNotified: !!(flag && flag.notified),
                timestamp: flag?.timestamp,
              });
              resolve();
            };
            request.onerror = () => {
              event.source.postMessage({
                type: "NOTIFICATION_FLAG_RESULT",
                sessionId: event.data.sessionId,
                wasNotified: false,
              });
              resolve();
            };
          });
        } catch (e) {
          event.source.postMessage({
            type: "NOTIFICATION_FLAG_RESULT",
            sessionId: event.data.sessionId,
            wasNotified: false,
          });
        }
      })(),
    );
  }

  if (event.data.type === "CLEAR_NOTIFICATION_FLAG") {
    event.waitUntil(
      (async () => {
        try {
          const db = await openDB();
          const tx = db.transaction(NOTIFICATION_STORE, "readwrite");
          const store = tx.objectStore(NOTIFICATION_STORE);
          store.delete(event.data.sessionId);
        } catch (e) {
          console.error("[SW] Failed to clear notification flag:", e);
        }
      })(),
    );
  }
});
