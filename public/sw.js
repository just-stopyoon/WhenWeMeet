// Web Push service worker (issue #14 T4). It handles only push and
// notificationclick: no fetch handler, offline cache or subscription change.
// The handlers are named globals so tests can call them with stand-in events,
// clients and registration objects.

const defaultTitle = '언제 만날래';
const defaultBody = '새 소식이 있어요.';
const notificationIcon = '/icons/icon-192.png';
const openRoomMessage = 'wwm-open-room';

// A missing or broken payload still shows a notification: iOS cancels the
// subscription when a push shows nothing.
function readPushPayload(data) {
  try {
    const payload = data ? data.json() : null;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};
  } catch {
    return {};
  }
}

function text(value) {
  return typeof value === 'string' && value ? value : null;
}

function handlePush(event, registration) {
  const payload = readPushPayload(event.data);
  const options = {
    body: text(payload.body) ?? defaultBody,
    icon: notificationIcon,
    data: { url: text(payload.url) ?? '/' },
  };
  const tag = text(payload.tag);
  if (tag) options.tag = tag;
  event.waitUntil(
    registration.showNotification(text(payload.title) ?? defaultTitle, options),
  );
}

// Only a same-origin /?room= address opens; anything else opens the home.
function notificationTarget(data, origin) {
  const raw = data && typeof data === 'object' ? data.url : undefined;
  if (typeof raw !== 'string') return '/';
  try {
    const url = new URL(raw, origin);
    const path = url.pathname + url.search;
    return url.origin === origin && path.startsWith('/?room=') ? path : '/';
  } catch {
    return '/';
  }
}

async function openTarget(clients, origin, target) {
  const windows = await clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const open = windows.find((client) => {
    try {
      return new URL(client.url).origin === origin;
    } catch {
      return false;
    }
  });
  if (!open) {
    await clients.openWindow(target);
    return;
  }
  let focused = open;
  try {
    focused = (await open.focus()) ?? open;
  } catch {
    // Focus can be refused; the open window still gets the room message.
  }
  focused.postMessage({ type: openRoomMessage, url: target });
}

function handleNotificationClick(event, clients, origin) {
  event.notification.close();
  const target = notificationTarget(event.notification.data, origin);
  event.waitUntil(openTarget(clients, origin, target));
}

self.addEventListener('push', (event) => handlePush(event, self.registration));
self.addEventListener('notificationclick', (event) =>
  handleNotificationClick(event, self.clients, self.location.origin),
);
