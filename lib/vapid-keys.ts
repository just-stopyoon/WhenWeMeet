// VAPID key pair kept in a one-row D1 table (ADR 0001). Storage is injected so
// unit tests run without D1; the D1 adapter arrives with the migration (T2).
// The private JWK never leaves this module except towards the signer.

import { base64UrlDecode, base64UrlEncode } from './push-subscription';

export type StoredVapidKey = {
  // Uncompressed P-256 point (65 bytes), base64url, for PushManager.subscribe.
  publicKey: string;
  // Exportable private key as a JSON-encoded JWK.
  privateJwk: string;
};

export type VapidKeyStore = {
  read(): Promise<StoredVapidKey | null>;
  // Must keep an existing row: concurrent first requests all re-read one key.
  insertIfAbsent(key: StoredVapidKey): Promise<void>;
};

export class VapidKeyError extends Error {
  constructor() {
    super('VAPID key is unavailable.');
    this.name = 'VapidKeyError';
  }
}

export async function generateVapidKey(): Promise<StoredVapidKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: base64UrlEncode(raw), privateJwk: JSON.stringify(jwk) };
}

// Checks a stored row and returns its signing key. A damaged row (bad format,
// or a private key that does not match the public key) is a key failure; it
// is never replaced automatically, since that would void every subscription
// (ADR 0001).
export async function importVapidKey(key: unknown): Promise<CryptoKey> {
  try {
    const { publicKey, privateJwk } = (key ?? {}) as Partial<StoredVapidKey>;
    if (typeof publicKey !== 'string' || typeof privateJwk !== 'string')
      throw new VapidKeyError();
    const point = base64UrlDecode(publicKey);
    if (point?.length !== 65 || point[0] !== 0x04) throw new VapidKeyError();
    const jwk = JSON.parse(privateJwk) as unknown;
    if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk))
      throw new VapidKeyError();
    const { kty, crv, x, y, d } = jwk as Record<string, unknown>;
    if (
      kty !== 'EC' ||
      crv !== 'P-256' ||
      typeof d !== 'string' ||
      x !== base64UrlEncode(point.slice(1, 33)) ||
      y !== base64UrlEncode(point.slice(33))
    )
      throw new VapidKeyError();
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
    const signingKey = await crypto.subtle.importKey(
      'jwk',
      { kty, crv, x, y, d },
      algorithm,
      false,
      ['sign'],
    );
    const verifyKey = await crypto.subtle.importKey(
      'raw',
      point,
      algorithm,
      false,
      ['verify'],
    );
    const probe = new TextEncoder().encode('whenwemeet vapid key check');
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      probe,
    );
    const matches = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      signature,
      probe,
    );
    if (!matches) throw new VapidKeyError();
    return signingKey;
  } catch {
    throw new VapidKeyError();
  }
}

// Errors are replaced with a fixed one so storage messages cannot carry keys.
export async function loadVapidKey(
  store: VapidKeyStore,
): Promise<StoredVapidKey> {
  try {
    const existing = await store.read();
    if (existing) {
      await importVapidKey(existing);
      return existing;
    }
    await store.insertIfAbsent(await generateVapidKey());
    const stored = await store.read();
    if (stored) {
      await importVapidKey(stored);
      return stored;
    }
  } catch {
    // Fall through to the fixed error below.
  }
  throw new VapidKeyError();
}

export async function loadPushPublicKey(store: VapidKeyStore): Promise<string> {
  return (await loadVapidKey(store)).publicKey;
}

// Response assembly (R4·R10): a key failure only removes `pushPublicKey`.
export async function withPushPublicKey<T extends object>(
  body: T,
  store: VapidKeyStore,
  log: (line: string) => void = console.warn,
): Promise<T & { pushPublicKey?: string }> {
  try {
    return { ...body, pushPublicKey: await loadPushPublicKey(store) };
  } catch {
    log('WEB_PUSH_KEY_UNAVAILABLE');
    return body;
  }
}
