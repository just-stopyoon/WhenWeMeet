// Web Push delivery with plain WebCrypto (no dependencies): RFC 8291
// `aes128gcm` payload encryption and RFC 8292 VAPID. Storage and `fetch` are
// injected; this module never imports `cloudflare:workers`.

import {
  base64UrlDecode,
  base64UrlEncode,
  checkPushSubscription,
  importReceiverKey,
  pushHostKind,
  type PushSubscriptionRecord,
} from './push-subscription';
import { importVapidKey, type StoredVapidKey } from './vapid-keys';

export const vapidSubject =
  'https://github.com/just-stopyoon/WhenWeMeet/issues';
export const pushTimeoutMs = 10_000;
const recordSize = 4096;
const jwtLifetimeSeconds = 12 * 60 * 60;
const encoder = new TextEncoder();

export type SenderKey = {
  privateKey: CryptoKey;
  publicKey: Uint8Array<ArrayBuffer>;
};

export type EncryptionOverrides = {
  salt?: Uint8Array<ArrayBuffer>;
  senderKey?: SenderKey;
};

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      key,
      length * 8,
    ),
  );
}

async function newSenderKey(): Promise<SenderKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey('raw', pair.publicKey),
    ),
  };
}

// RFC 8291 section 3 with a single record (RFC 8188 header + one record).
export async function encryptPayload(
  plaintext: Uint8Array<ArrayBuffer>,
  subscription: Pick<PushSubscriptionRecord, 'p256dh' | 'auth'>,
  overrides: EncryptionOverrides = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const receiver = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  if (receiver?.length !== 65 || authSecret?.length !== 16)
    throw new Error('Invalid subscription keys.');
  // RFC 8291 section 4: rs must exceed plaintext + delimiter + 16-byte tag.
  if (plaintext.length + 1 + 16 >= recordSize)
    throw new Error('Push payload is too large.');
  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const sender = overrides.senderKey ?? (await newSenderKey());
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importReceiverKey(receiver) },
      sender.privateKey,
      256,
    ),
  );
  const keyInfo = concat(
    encoder.encode('WebPush: info\0'),
    receiver,
    sender.publicKey,
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode('Content-Encoding: nonce\0'),
    12,
  );
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, [
    'encrypt',
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(plaintext, new Uint8Array([0x02])),
    ),
  );
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = sender.publicKey.length;
  return concat(header, sender.publicKey, ciphertext);
}

// RFC 8292 section 2: ES256 JWT whose audience is the push service origin.
export async function vapidAuthorization(
  endpoint: string,
  vapid: StoredVapidKey,
  signingKey: CryptoKey,
  nowMs: number,
): Promise<string> {
  const json = (value: object) =>
    base64UrlEncode(encoder.encode(JSON.stringify(value)));
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + jwtLifetimeSeconds,
    sub: vapidSubject,
  })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      encoder.encode(unsigned),
    ),
  );
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

// Result classes (issue #14 T1 table). Only these names and the status code are
// ever logged: never the endpoint, p256dh, auth, JWT or private key.
export type PushOutcome =
  | { kind: 'sent'; status: number }
  | { kind: 'gone'; status: 404 | 410 }
  | { kind: 'http-failure'; status: number }
  | { kind: 'transport-failure' }
  | { kind: 'key-failure' }
  | { kind: 'invalid-subscription' }
  | { kind: 'blocked' }
  // The caller's last check right before the network said the row changed.
  | { kind: 'stale' };

export type PushDelivery = {
  subscription: PushSubscriptionRecord;
  outcome: PushOutcome;
};

export type SendPushOptions = {
  subscriptions: readonly PushSubscriptionRecord[];
  roomId: string;
  payload: string;
  vapid: StoredVapidKey;
  fetch: typeof fetch;
  // Test-server switch (R9): sign and encrypt, then skip the network.
  blocked?: boolean;
  // Last check right before the network (and before the blocked branch), by
  // index into `subscriptions`; false or an exception skips that one.
  confirm?: (index: number) => Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
  encryption?: EncryptionOverrides;
};

export function classifyStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return { kind: 'sent', status };
  if (status === 404 || status === 410) return { kind: 'gone', status };
  return { kind: 'http-failure', status };
}

function describe(outcome: PushOutcome): string {
  return 'status' in outcome
    ? `WEB_PUSH_RESULT ${outcome.kind} status=${outcome.status}`
    : `WEB_PUSH_RESULT ${outcome.kind}`;
}

async function deliver(
  subscription: PushSubscriptionRecord,
  index: number,
  options: SendPushOptions,
  signingKey: Promise<CryptoKey | null>,
  deadline: AbortSignal,
  log: (line: string) => void,
): Promise<PushOutcome> {
  // Check again right before sending (Q14): stored rows may predate a rule.
  const checked = await checkPushSubscription({
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  });
  const host = checked && pushHostKind(checked.endpoint);
  if (!checked || !host) return { kind: 'invalid-subscription' };
  const key = await signingKey;
  if (!key) return { kind: 'key-failure' };
  let body: Uint8Array<ArrayBuffer>;
  let authorization: string;
  try {
    body = await encryptPayload(
      encoder.encode(options.payload),
      checked,
      options.encryption,
    );
    authorization = await vapidAuthorization(
      checked.endpoint,
      options.vapid,
      key,
      (options.now ?? Date.now)(),
    );
  } catch {
    return { kind: 'key-failure' };
  }
  if (options.confirm) {
    let current = false;
    try {
      current = await options.confirm(index);
    } catch {
      // A failed check is treated like a changed row: nothing is sent.
    }
    if (!current) return { kind: 'stale' };
  }
  // The 10-second limit covers the whole subscription, not only the request:
  // a deadline that passed while checking, signing or encrypting sends nothing.
  if (deadline.aborted) return { kind: 'transport-failure' };
  if (options.blocked) {
    log(`WEB_PUSH_BLOCKED_ATTEMPT host=${host}`);
    return { kind: 'blocked' };
  }
  log(`WEB_PUSH_NETWORK_ATTEMPT host=${host}`);
  try {
    const response = await options.fetch(checked.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        TTL: '86400',
        Urgency: 'normal',
        Topic: options.roomId.replaceAll('-', ''),
        Authorization: authorization,
      },
      body,
      redirect: 'manual',
      signal: deadline,
    });
    void response.body?.cancel().catch(() => undefined);
    return classifyStatus(response.status);
  } catch {
    return { kind: 'transport-failure' };
  }
}

// Sends to every subscription independently; no retries. One subscription's
// failure (or exception) never stops the others.
export async function sendPush(
  options: SendPushOptions,
): Promise<PushDelivery[]> {
  const log = options.log ?? console.log;
  // Each subscription's 10-second limit starts now, before any await.
  const deadlines = options.subscriptions.map(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), pushTimeoutMs);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  });
  const signingKey = importVapidKey(options.vapid).catch(() => null);
  return Promise.all(
    options.subscriptions.map(async (subscription, index) => {
      const deadline = deadlines[index];
      let outcome: PushOutcome;
      // The limit also ends the wait for this subscription's result: a check,
      // signing or encryption that never finishes cannot hold the others'
      // cleanup. A step that finishes late still sends nothing (deliver
      // checks the deadline right before the network).
      const expired = new Promise<PushOutcome>((resolve) => {
        const end = () => resolve({ kind: 'transport-failure' });
        if (deadline.signal.aborted) end();
        else deadline.signal.addEventListener('abort', end, { once: true });
      });
      const delivering = deliver(
        subscription,
        index,
        options,
        signingKey,
        deadline.signal,
        log,
      );
      // A rejection after the limit already won is not unhandled; an earlier
      // one still reaches the catch below through the race.
      delivering.catch(() => undefined);
      try {
        outcome = await Promise.race([delivering, expired]);
      } catch {
        outcome = { kind: 'transport-failure' };
      } finally {
        deadline.clear();
      }
      try {
        log(describe(outcome));
      } catch {
        // Logging must not affect delivery results.
      }
      return { subscription, outcome };
    }),
  );
}

// Workers glue reads this var; only scripts/test-server.mjs passes it (R9).
export const pushSendBlockedVar = 'WHENWEMEET_PUSH_SEND_BLOCKED';

export function isPushSendBlocked(env: object): boolean {
  return (env as Record<string, unknown>)[pushSendBlockedVar] === '1';
}
