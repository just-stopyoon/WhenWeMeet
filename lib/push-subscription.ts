// Web Push subscription checks shared by registration (T2) and delivery (T1).
// Pure WebCrypto only: this module runs in Workers and in Node unit tests.

export type PushSubscriptionRecord = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushHostKind = 'fcm' | 'mozilla' | 'apple' | 'windows';

// Known push services only, so the server never posts to arbitrary hosts.
const pushHosts: readonly {
  kind: PushHostKind;
  match: 'exact' | 'suffix';
  host: string;
}[] = [
  { kind: 'fcm', match: 'exact', host: 'fcm.googleapis.com' },
  {
    kind: 'mozilla',
    match: 'exact',
    host: 'updates.push.services.mozilla.com',
  },
  { kind: 'apple', match: 'suffix', host: '.push.apple.com' },
  { kind: 'windows', match: 'suffix', host: '.notify.windows.com' },
];

export const maxEndpointLength = 2048;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function pushHostKind(endpoint: string): PushHostKind | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = url.hostname;
  for (const entry of pushHosts) {
    if (
      entry.match === 'exact' ? host === entry.host : host.endsWith(entry.host)
    )
      return entry.kind;
  }
  return null;
}

export async function importReceiverKey(
  p256dh: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    p256dh,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

// One spelling per push address: only the serialised URL that `fetch` sends
// to is accepted, so registration, removal and delivery key on one string.
// A fragment (even an empty `#`) is never sent over HTTP, so it would split one
// address into several rows; it is rejected rather than stripped.
// T2 uses this for both `pushSubscribe` and `pushUnsubscribe`.
export function checkPushEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > maxEndpointLength)
    return null;
  if (value.includes('#')) return null;
  if (pushHostKind(value) === null) return null;
  return new URL(value).href === value ? value : null;
}

// Returns the normalised record, or null when any field fails the check.
export async function checkPushSubscription(
  value: unknown,
): Promise<PushSubscriptionRecord | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || checkPushEndpoint(endpoint) === null)
    return null;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys))
    return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  const receiver = base64UrlDecode(p256dh);
  const secret = base64UrlDecode(auth);
  if (receiver?.length !== 65 || receiver[0] !== 0x04) return null;
  if (secret?.length !== 16) return null;
  try {
    await importReceiverKey(receiver);
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}
