import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base64UrlDecode,
  base64UrlEncode,
  checkPushEndpoint,
  checkPushSubscription,
  maxEndpointLength,
  pushHostKind,
  type PushSubscriptionRecord,
} from '../lib/push-subscription';
import {
  generateVapidKey,
  loadPushPublicKey,
  loadVapidKey,
  VapidKeyError,
  withPushPublicKey,
  type StoredVapidKey,
  type VapidKeyStore,
} from '../lib/vapid-keys';
import {
  encryptPayload,
  isPushSendBlocked,
  pushSendBlockedVar,
  sendPush,
  vapidSubject,
  type SendPushOptions,
} from '../lib/web-push';

// RFC 8291 section 5 and appendix A.
const rfc = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const encoder = new TextEncoder();
const roomId = '0f8fad5b-d9cb-469f-a165-70867728950e';

function bytes(value: string) {
  const decoded = base64UrlDecode(value);
  assert.ok(decoded, `invalid base64url: ${value}`);
  return decoded;
}

function privateJwk(publicKey: string, d: string): JsonWebKey {
  const point = bytes(publicKey);
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(point.slice(1, 33)),
    y: base64UrlEncode(point.slice(33, 65)),
    d,
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
) {
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

function join(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

// Receiver side of RFC 8291, written independently of lib/web-push.ts.
async function decrypt(body: Uint8Array<ArrayBuffer>) {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer).getUint32(16);
  const idLength = body[20];
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const receiverPrivate = await crypto.subtle.importKey(
    'jwk',
    privateJwk(rfc.uaPublic, rfc.uaPrivate),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const senderKey = await crypto.subtle.importKey(
    'raw',
    senderPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: senderKey },
      receiverPrivate,
      256,
    ),
  );
  const ikm = await hkdf(
    bytes(rfc.auth),
    secret,
    join(encoder.encode('WebPush: info\0'), bytes(rfc.uaPublic), senderPublic),
    32,
  );
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
    'decrypt',
  ]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      ciphertext,
    ),
  );
  assert.equal(padded.at(-1), 0x02);
  return {
    recordSize,
    idLength,
    text: new TextDecoder().decode(padded.slice(0, -1)),
  };
}

function subscription(endpoint: string): PushSubscriptionRecord {
  return { endpoint, p256dh: rfc.uaPublic, auth: rfc.auth };
}

type Call = { url: string; init: RequestInit };

function urlOf(input: string | URL | Request) {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: urlOf(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

let sharedVapid: Promise<StoredVapidKey> | undefined;
function vapid() {
  sharedVapid ??= generateVapidKey();
  return sharedVapid;
}

async function send(
  overrides: Partial<SendPushOptions> & Pick<SendPushOptions, 'fetch'>,
) {
  const lines: string[] = [];
  const results = await sendPush({
    subscriptions: [subscription('https://fcm.googleapis.com/fcm/send/abc')],
    roomId,
    payload: '{"title":"방"}',
    vapid: await vapid(),
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { results, lines };
}

// --- payload encryption -----------------------------------------------------

void test('RFC 8291 부록 A 입력으로 같은 암호문을 만든다', async () => {
  const senderPrivate = await crypto.subtle.importKey(
    'jwk',
    privateJwk(rfc.asPublic, rfc.asPrivate),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const body = await encryptPayload(
    encoder.encode(rfc.plaintext),
    { p256dh: rfc.uaPublic, auth: rfc.auth },
    {
      salt: bytes(rfc.salt),
      senderKey: { privateKey: senderPrivate, publicKey: bytes(rfc.asPublic) },
    },
  );
  assert.equal(base64UrlEncode(body), rfc.body);
});

void test('평소에는 salt와 보내는 쪽 키를 매번 새로 만든다', async () => {
  const subscriber = { p256dh: rfc.uaPublic, auth: rfc.auth };
  const first = await encryptPayload(encoder.encode('같은 글'), subscriber);
  const second = await encryptPayload(encoder.encode('같은 글'), subscriber);
  assert.notDeepEqual(first.slice(0, 16), second.slice(0, 16));
  assert.notDeepEqual(first.slice(21, 86), second.slice(21, 86));
  assert.equal((await decrypt(first)).text, '같은 글');
  assert.equal((await decrypt(second)).text, '같은 글');
});

// --- request ----------------------------------------------------------------

void test('요청 헤더 다섯 개·리디렉션 금지·호출 1회로 보낸다', async () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def';
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  const now = Date.UTC(2099, 0, 1);
  const { results } = await send({
    fetch,
    subscriptions: [subscription(endpoint)],
    payload: '{"title":"방 이름"}',
    now: () => now,
  });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
  const headers = init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).sort(), [
    'Authorization',
    'Content-Encoding',
    'TTL',
    'Topic',
    'Urgency',
  ]);
  assert.equal(headers['Content-Encoding'], 'aes128gcm');
  assert.equal(headers.TTL, '86400');
  assert.equal(headers.Urgency, 'normal');
  assert.equal(headers.Topic, '0f8fad5bd9cb469fa16570867728950e');
  assert.equal(headers.Topic.length, 32);

  const decrypted = await decrypt(init.body as Uint8Array<ArrayBuffer>);
  assert.deepEqual(decrypted, {
    recordSize: 4096,
    idLength: 65,
    text: '{"title":"방 이름"}',
  });

  const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization);
  assert.ok(match);
  const [, jwt, k] = match;
  assert.equal(k, (await vapid()).publicKey);
  const [header, claims, signature] = jwt.split('.');
  const decode = (part: string) =>
    JSON.parse(new TextDecoder().decode(bytes(part))) as Record<
      string,
      unknown
    >;
  assert.deepEqual(decode(header), { typ: 'JWT', alg: 'ES256' });
  const payload = decode(claims);
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'sub']);
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, vapidSubject);
  assert.equal(
    vapidSubject,
    'https://github.com/just-stopyoon/WhenWeMeet/issues',
  );
  assert.equal(typeof payload.exp, 'number');
  const exp = payload.exp as number;
  assert.ok(exp > now / 1000);
  assert.ok(exp <= now / 1000 + 24 * 60 * 60);
  const publicKey = await crypto.subtle.importKey(
    'raw',
    bytes(k),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  assert.ok(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      bytes(signature),
      encoder.encode(`${header}.${claims}`),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.outcome),
    [{ kind: 'sent', status: 201 }],
  );
});

void test('VAPID aud는 구독 주소마다 그 origin이다', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  await send({
    fetch,
    subscriptions: [
      subscription('https://web.push.apple.com/QGuQyavXutnMH'),
      subscription('https://updates.push.services.mozilla.com/wpush/v2/gAAA'),
    ],
  });
  const audiences = calls.map(({ init }) => {
    const value = (init.headers as Record<string, string>).Authorization;
    const claims = /t=[^.]+\.([^.]+)\./.exec(value)?.[1] ?? '';
    return (
      JSON.parse(new TextDecoder().decode(bytes(claims))) as { aud: string }
    ).aud;
  });
  assert.deepEqual(audiences, [
    'https://web.push.apple.com',
    'https://updates.push.services.mozilla.com',
  ]);
});

// --- result classes ---------------------------------------------------------

for (const [status, outcome] of [
  [201, { kind: 'sent', status: 201 }],
  [301, { kind: 'http-failure', status: 301 }],
  [404, { kind: 'gone', status: 404 }],
  [410, { kind: 'gone', status: 410 }],
  [403, { kind: 'http-failure', status: 403 }],
  [500, { kind: 'http-failure', status: 500 }],
] as const) {
  void test(`응답 ${status}은 ${outcome.kind}로 분류하고 재시도하지 않는다`, async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(null, {
          status,
          headers:
            status === 301 ? { Location: 'https://example.com/' } : undefined,
        }),
    );
    const { results, lines } = await send({ fetch });
    assert.equal(calls.length, 1);
    assert.deepEqual(results[0].outcome, outcome);
    assert.deepEqual(lines, [
      'WEB_PUSH_NETWORK_ATTEMPT host=fcm',
      `WEB_PUSH_RESULT ${outcome.kind} status=${status}`,
    ]);
  });
}

void test('네트워크 거절은 전송 실패로 분류한다', async () => {
  const { fetch, calls } = fakeFetch(() => {
    throw new TypeError('connection refused');
  });
  const { results, lines } = await send({ fetch });
  assert.equal(calls.length, 1);
  assert.deepEqual(results[0].outcome, { kind: 'transport-failure' });
  assert.deepEqual(lines, [
    'WEB_PUSH_NETWORK_ATTEMPT host=fcm',
    'WEB_PUSH_RESULT transport-failure',
  ]);
});

void test('10초 안에 응답이 없으면 끊고 전송 실패로 분류한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  let called!: () => void;
  const fetchCalled = new Promise<void>((resolve) => (called = resolve));
  const { fetch } = fakeFetch(
    ({ init }) =>
      new Promise<Response>((_, reject) => {
        signal = init.signal ?? undefined;
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        called();
      }),
  );
  const pending = send({ fetch });
  // Fail instead of hanging when sending ends without ever calling fetch.
  await Promise.race([
    fetchCalled,
    pending.then(() => assert.fail('fetch was never called')),
  ]);
  t.mock.timers.tick(9_999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal?.aborted, true);
  const { results } = await pending;
  assert.deepEqual(results[0].outcome, { kind: 'transport-failure' });
});

void test('서명·암호화를 기다리는 사이 10초가 지나면 보내지 않는다', async (t) => {
  const key = await vapid();
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (begin = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  t.mock.method(
    crypto.subtle,
    'sign',
    async (...args: Parameters<SubtleCrypto['sign']>) => {
      begin();
      await gate;
      return sign(...args);
    },
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  const pending = send({ fetch, vapid: key });
  await Promise.race([
    started,
    pending.then(() => assert.fail('signing was never awaited')),
  ]);
  t.mock.timers.tick(10_000);
  release();
  const { results, lines } = await pending;
  assert.equal(calls.length, 0);
  assert.deepEqual(results[0].outcome, { kind: 'transport-failure' });
  assert.deepEqual(lines, ['WEB_PUSH_RESULT transport-failure']);
});

void test('한 구독의 실패·예외가 다른 구독의 발송을 막지 않는다', async () => {
  const failing = 'https://fcm.googleapis.com/fcm/send/fail';
  const working = 'https://web.push.apple.com/ok';
  const calls: string[] = [];
  const fetcher = ((input: string | URL | Request) => {
    calls.push(urlOf(input));
    if (urlOf(input) === failing) throw new Error('synchronous failure');
    return Promise.resolve(new Response(null, { status: 201 }));
  }) as typeof fetch;
  const { results } = await send({
    fetch: fetcher,
    subscriptions: [subscription(failing), subscription(working)],
  });
  assert.deepEqual(calls.sort(), [failing, working].sort());
  assert.deepEqual(
    results.map(({ subscription: { endpoint }, outcome }) => [
      endpoint,
      outcome.kind,
    ]),
    [
      [failing, 'transport-failure'],
      [working, 'sent'],
    ],
  );
});

void test('보내기 직전 구독 검사에 걸리면 보내지 않는다', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  const { results, lines } = await send({
    fetch,
    subscriptions: [
      subscription('http://fcm.googleapis.com/fcm/send/abc'),
      { ...subscription('https://fcm.googleapis.com/x'), auth: 'short' },
    ],
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    results.map((result) => result.outcome),
    [{ kind: 'invalid-subscription' }, { kind: 'invalid-subscription' }],
  );
  assert.deepEqual(lines, [
    'WEB_PUSH_RESULT invalid-subscription',
    'WEB_PUSH_RESULT invalid-subscription',
  ]);
});

void test('VAPID 키를 가져오지 못하거나 암호화가 실패하면 키 실패다', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  const broken = await send({
    fetch,
    vapid: { publicKey: (await vapid()).publicKey, privateJwk: '{"kty":"EC"}' },
  });
  const tooLarge = await send({ fetch, payload: 'x'.repeat(4096) });
  assert.equal(calls.length, 0);
  assert.deepEqual(broken.results[0].outcome, { kind: 'key-failure' });
  assert.deepEqual(tooLarge.results[0].outcome, { kind: 'key-failure' });
  assert.deepEqual(broken.lines, ['WEB_PUSH_RESULT key-failure']);
});

void test('평문은 레코드 하나(rs 4096)에 들어가는 4078바이트까지 받는다', async () => {
  const subscriber = { p256dh: rfc.uaPublic, auth: rfc.auth };
  const largest = 'x'.repeat(4078);
  const body = await encryptPayload(encoder.encode(largest), subscriber);
  const decrypted = await decrypt(body);
  assert.equal(decrypted.text, largest);
  assert.equal(body.length - 86, 4095);
  await assert.rejects(
    encryptPayload(encoder.encode('x'.repeat(4079)), subscriber),
  );
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  assert.deepEqual(
    (await send({ fetch, payload: largest })).results[0].outcome,
    {
      kind: 'sent',
      status: 201,
    },
  );
  assert.deepEqual(
    (await send({ fetch, payload: 'x'.repeat(4079) })).results[0].outcome,
    { kind: 'key-failure' },
  );
  assert.equal(calls.length, 1);
});

void test('기록에는 분류 이름·상태 코드·호스트 종류만 남는다', async () => {
  const key = await vapid();
  const endpoints = [
    'https://fcm.googleapis.com/fcm/send/secret-fcm-token',
    'https://web.push.apple.com/secret-apple-token',
    'https://wns2-par02p.notify.windows.com/w/?token=secret-wns-token',
    'https://updates.push.services.mozilla.com/wpush/v2/secret-moz-token',
  ];
  const statuses = [201, 410, 500, 404];
  const authorizations: string[] = [];
  const { fetch } = fakeFetch(({ url, init }) => {
    authorizations.push((init.headers as Record<string, string>).Authorization);
    return new Response(null, { status: statuses[endpoints.indexOf(url)] });
  });
  const { lines } = await send({
    fetch,
    vapid: key,
    subscriptions: endpoints.map(subscription),
  });
  assert.deepEqual(lines.sort(), [
    'WEB_PUSH_NETWORK_ATTEMPT host=apple',
    'WEB_PUSH_NETWORK_ATTEMPT host=fcm',
    'WEB_PUSH_NETWORK_ATTEMPT host=mozilla',
    'WEB_PUSH_NETWORK_ATTEMPT host=windows',
    'WEB_PUSH_RESULT gone status=404',
    'WEB_PUSH_RESULT gone status=410',
    'WEB_PUSH_RESULT http-failure status=500',
    'WEB_PUSH_RESULT sent status=201',
  ]);
  const text = lines.join('\n');
  const jwk = JSON.parse(key.privateJwk) as JsonWebKey;
  assert.ok(jwk.d);
  for (const secret of [
    ...endpoints,
    'secret',
    'token',
    rfc.uaPublic,
    rfc.auth,
    jwk.d,
    key.privateJwk,
    ...authorizations,
    ...authorizations.map((value) => value.split(', ')[0].slice(8)),
  ])
    assert.equal(text.includes(secret), false, secret);
});

void test('발송 차단 중이면 서명·암호화 뒤 네트워크로 나가지 않는다', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  const { results, lines } = await send({
    fetch,
    blocked: true,
    subscriptions: [
      subscription('https://web.push.apple.com/abc'),
      subscription('http://web.push.apple.com/abc'),
      subscription('https://fcm.googleapis.com/abc'),
    ],
    vapid: await vapid(),
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    results.map((result) => result.outcome.kind),
    ['blocked', 'invalid-subscription', 'blocked'],
  );
  // Deliveries run in parallel, so log lines follow completion order.
  assert.deepEqual(lines.filter((line) => line.includes('ATTEMPT')).sort(), [
    'WEB_PUSH_BLOCKED_ATTEMPT host=apple',
    'WEB_PUSH_BLOCKED_ATTEMPT host=fcm',
  ]);

  const broken = await send({
    fetch,
    blocked: true,
    vapid: { publicKey: (await vapid()).publicKey, privateJwk: 'not json' },
  });
  assert.deepEqual(broken.lines, ['WEB_PUSH_RESULT key-failure']);

  // A valid key whose encryption or signing step fails must not reach the
  // blocked branch: blocking happens only after both succeed.
  const encryptionFails = await send({
    fetch,
    blocked: true,
    payload: 'x'.repeat(4079),
  });
  const signingFails = await send({
    fetch,
    blocked: true,
    now: () => {
      throw new Error('clock failure');
    },
  });
  for (const failed of [encryptionFails, signingFails]) {
    assert.deepEqual(failed.results[0].outcome, { kind: 'key-failure' });
    assert.deepEqual(failed.lines, ['WEB_PUSH_RESULT key-failure']);
  }
  assert.equal(calls.length, 0);
});

void test('발송 차단 설정은 테스트 서버 변수 값 "1"일 때만 켜진다', () => {
  assert.equal(pushSendBlockedVar, 'WHENWEMEET_PUSH_SEND_BLOCKED');
  assert.equal(isPushSendBlocked({ [pushSendBlockedVar]: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 1, true, null])
    assert.equal(isPushSendBlocked({ [pushSendBlockedVar]: value }), false);
  assert.equal(isPushSendBlocked({}), false);
});

// --- VAPID key store --------------------------------------------------------

function memoryStore(options: { delayMs?: number } = {}) {
  let row: StoredVapidKey | null = null;
  const pause = () =>
    new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5));
  const store: VapidKeyStore & { inserts: number; row(): unknown } = {
    inserts: 0,
    row: () => row,
    async read() {
      await pause();
      return row && { ...row };
    },
    async insertIfAbsent(key) {
      store.inserts++;
      await pause();
      row ??= { ...key };
    },
  };
  return store;
}

void test('빈 저장소에 동시에 두 번 요청해도 같은 공개 키가 나오고 유지된다', async () => {
  const store = memoryStore();
  const [first, second] = await Promise.all([
    loadPushPublicKey(store),
    loadPushPublicKey(store),
  ]);
  assert.equal(store.inserts, 2);
  assert.equal(first, second);
  assert.equal(await loadPushPublicKey(store), first);
  assert.equal(store.inserts, 2);
  const point = bytes(first);
  assert.equal(point.length, 65);
  assert.equal(point[0], 0x04);
  const stored = store.row() as StoredVapidKey;
  const jwk = JSON.parse(stored.privateJwk) as JsonWebKey;
  assert.equal(jwk.kty, 'EC');
  assert.equal(jwk.crv, 'P-256');
  assert.equal(typeof jwk.d, 'string');
  assert.equal(stored.publicKey, first);
});

void test('공개 키 응답 조립에는 비공개 JWK가 없다', async () => {
  const store = memoryStore({ delayMs: 0 });
  const body = await withPushPublicKey({ user: 'a', rooms: [] }, store);
  const stored = store.row() as StoredVapidKey;
  const d = (JSON.parse(stored.privateJwk) as JsonWebKey).d ?? '';
  assert.deepEqual(body, {
    user: 'a',
    rooms: [],
    pushPublicKey: stored.publicKey,
  });
  assert.ok(d.length > 0);
  assert.equal(JSON.stringify(body).includes(d), false);
  assert.equal(JSON.stringify(body).includes('"d"'), false);
});

void test('저장소 읽기·생성이 실패하면 응답은 키만 빠지고 그대로다', async () => {
  const leaked = privateJwk(rfc.asPublic, rfc.asPrivate);
  const secret = JSON.stringify(leaked);
  const failures: Record<string, VapidKeyStore> = {
    '읽기 실패': {
      read: () => Promise.reject(new Error(`read failed ${secret}`)),
      insertIfAbsent: () => Promise.resolve(),
    },
    '생성 실패': {
      read: () => Promise.resolve(null),
      insertIfAbsent: () => Promise.reject(new Error(`no table ${secret}`)),
    },
    '생성 뒤 행 없음': {
      read: () => Promise.resolve(null),
      insertIfAbsent: () => Promise.resolve(),
    },
  };
  for (const [name, store] of Object.entries(failures)) {
    const body = {
      user: 'friend',
      nickname: '친구',
      rooms: [{ id: roomId }],
    };
    const original = structuredClone(body);
    const lines: string[] = [];
    const result = await withPushPublicKey(body, store, (line) =>
      lines.push(line),
    );
    assert.deepEqual(result, original, name);
    assert.equal('pushPublicKey' in result, false, name);
    assert.deepEqual(lines, ['WEB_PUSH_KEY_UNAVAILABLE'], name);

    const error = await loadVapidKey(store).then(
      () => assert.fail(`${name}: expected failure`),
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof VapidKeyError, name);
    const shown = `${error.message}\n${error.stack ?? ''}\n${String(error.cause)}`;
    assert.equal(shown.includes(rfc.asPrivate), false, name);
    assert.equal(error.cause, undefined, name);
  }
});

async function corruptKeys(): Promise<Record<string, StoredVapidKey>> {
  const good = await generateVapidKey();
  const other = await generateVapidKey();
  const jwk = JSON.parse(good.privateJwk) as JsonWebKey;
  const otherJwk = JSON.parse(other.privateJwk) as JsonWebKey;
  return {
    '다른 키의 공개 키': { ...good, publicKey: other.publicKey },
    '공개 키 길이 틀림': { ...good, publicKey: good.publicKey.slice(0, -4) },
    '공개 키 base64url 아님': { ...good, publicKey: `${good.publicKey}=` },
    '다른 키의 d': {
      ...good,
      privateJwk: JSON.stringify({ ...jwk, d: otherJwk.d }),
    },
    'd 없음': {
      ...good,
      privateJwk: JSON.stringify({ ...jwk, d: undefined }),
    },
    'JSON 아님': { ...good, privateJwk: '{' },
    'JSON 배열': { ...good, privateJwk: '[]' },
    '공개 키 숫자': { ...good, publicKey: 7 as unknown as string },
  };
}

void test('저장된 키 행이 손상되면 바꾸지 않고 응답에서 키만 뺀다', async () => {
  for (const [name, corrupt] of Object.entries(await corruptKeys())) {
    let inserts = 0;
    const store: VapidKeyStore = {
      read: () => Promise.resolve({ ...corrupt }),
      insertIfAbsent: () => {
        inserts++;
        return Promise.resolve();
      },
    };
    const lines: string[] = [];
    const body = { user: 'a', rooms: [] };
    assert.deepEqual(
      await withPushPublicKey(body, store, (line) => lines.push(line)),
      { user: 'a', rooms: [] },
      name,
    );
    assert.deepEqual(lines, ['WEB_PUSH_KEY_UNAVAILABLE'], name);
    await assert.rejects(loadVapidKey(store), VapidKeyError, name);
    assert.equal(inserts, 0, name);
  }

  // A row inserted by another request and re-read is checked the same way.
  const [corrupt] = Object.values(await corruptKeys());
  let row: StoredVapidKey | null = null;
  const racing: VapidKeyStore = {
    read: () => Promise.resolve(row),
    insertIfAbsent: () => {
      row = corrupt;
      return Promise.resolve();
    },
  };
  await assert.rejects(loadVapidKey(racing), VapidKeyError);
  assert.equal(row, corrupt);
});

void test('손상된 키로는 보내지 않고 키 실패로 분류한다', async () => {
  for (const [name, corrupt] of Object.entries(await corruptKeys())) {
    for (const blocked of [false, true]) {
      const { fetch, calls } = fakeFetch(
        () => new Response(null, { status: 201 }),
      );
      const { results, lines } = await send({ fetch, blocked, vapid: corrupt });
      assert.equal(calls.length, 0, name);
      assert.deepEqual(results[0].outcome, { kind: 'key-failure' }, name);
      assert.deepEqual(lines, ['WEB_PUSH_RESULT key-failure'], name);
    }
  }
});

// --- subscription check -----------------------------------------------------

const allowed = [
  ['https://fcm.googleapis.com/fcm/send/abc:APA91b', 'fcm'],
  ['https://updates.push.services.mozilla.com/wpush/v2/gAAAAA', 'mozilla'],
  ['https://web.push.apple.com/QGuQyavXutnMH', 'apple'],
  ['https://wns2-par02p.notify.windows.com/w/?token=BQYAAA', 'windows'],
] as const;

for (const [endpoint, kind] of allowed) {
  void test(`허용 호스트 ${kind} 구독은 통과한다`, async () => {
    assert.equal(pushHostKind(endpoint), kind);
    assert.deepEqual(
      await checkPushSubscription({
        endpoint,
        keys: { p256dh: rfc.uaPublic, auth: rfc.auth },
      }),
      { endpoint, p256dh: rfc.uaPublic, auth: rfc.auth },
    );
  });
}

void test('같은 주소의 다른 표기는 거절해 등록·해지·발송이 같은 문자열을 쓴다', async () => {
  const canonical = 'https://fcm.googleapis.com/fcm/send/abc';
  const keys = { p256dh: rfc.uaPublic, auth: rfc.auth };
  assert.equal(checkPushEndpoint(canonical), canonical);
  assert.deepEqual(await checkPushSubscription({ endpoint: canonical, keys }), {
    endpoint: canonical,
    ...keys,
  });
  for (const variant of [
    'https://FCM.googleapis.com/fcm/send/abc',
    'HTTPS://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
    'https://fcm.googleapis.com/fcm/x/../send/abc',
    ' https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com/fcm/send/abc ',
    'https://fcm.googleapis.com',
    'https:fcm.googleapis.com/fcm/send/abc',
    'https://web.push.apple.com/a b',
  ]) {
    assert.equal(new URL(variant).hostname.length > 0, true, variant);
    assert.equal(checkPushEndpoint(variant), null, variant);
    assert.equal(
      await checkPushSubscription({ endpoint: variant, keys }),
      null,
      variant,
    );
  }
  for (const value of [null, 0, [], {}, undefined, ''])
    assert.equal(checkPushEndpoint(value), null);
});

void test('endpoint는 2048자까지 받는다', async () => {
  const base = 'https://fcm.googleapis.com/fcm/send/';
  const exact = base + 'a'.repeat(maxEndpointLength - base.length);
  assert.equal(exact.length, 2048);
  const keys = { p256dh: rfc.uaPublic, auth: rfc.auth };
  assert.ok(await checkPushSubscription({ endpoint: exact, keys }));
  assert.equal(
    await checkPushSubscription({ endpoint: `${exact}a`, keys }),
    null,
  );
});

void test('구독 검사는 허용 밖 주소·형식·키를 거절한다', async () => {
  const good = 'https://fcm.googleapis.com/fcm/send/abc';
  const keys = { p256dh: rfc.uaPublic, auth: rfc.auth };
  const offCurve = new Uint8Array(65);
  offCurve[0] = 0x04;
  offCurve[32] = 1;
  offCurve[64] = 1;
  const compressedPrefix = bytes(rfc.uaPublic);
  compressedPrefix[0] = 0x02;
  const endpoints: unknown[] = [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://example.com/fcm/send/abc',
    'https://fcm.googleapis.com.example.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com.example.com/x',
    'https://web.push.apple.com.example.com/x',
    'https://a.notify.windows.com.example.com/x',
    'https://evilpush.apple.com/x',
    'https://push.apple.com/x',
    'https://notify.windows.com/x',
    'https://xfcm.googleapis.com/x',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://user@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://fcm.googleapis.com/' + 'a'.repeat(2049 - 27),
    'not a url',
    '',
    0,
    null,
    [],
    {},
    undefined,
  ];
  assert.equal((endpoints[13] as string).length, 2049);
  const rejected: unknown[] = [
    ...endpoints.map((endpoint) => ({ endpoint, keys })),
    null,
    undefined,
    0,
    'string',
    [],
    [{ endpoint: good, keys }],
    { endpoint: good },
    { endpoint: good, keys: null },
    { endpoint: good, keys: [] },
    { endpoint: good, keys: 'keys' },
    { endpoint: good, keys: { auth: rfc.auth } },
    { endpoint: good, keys: { p256dh: rfc.uaPublic } },
    { endpoint: good, keys: { p256dh: 65, auth: rfc.auth } },
    { endpoint: good, keys: { p256dh: null, auth: rfc.auth } },
    { endpoint: good, keys: { p256dh: [], auth: rfc.auth } },
    { endpoint: good, keys: { p256dh: '', auth: rfc.auth } },
    { endpoint: good, keys: { p256dh: rfc.uaPublic, auth: 16 } },
    { endpoint: good, keys: { p256dh: rfc.uaPublic, auth: '' } },
    {
      endpoint: good,
      keys: { p256dh: rfc.uaPublic.slice(0, -2), auth: rfc.auth },
    },
    { endpoint: good, keys: { p256dh: `${rfc.uaPublic}AA`, auth: rfc.auth } },
    { endpoint: good, keys: { p256dh: `${rfc.uaPublic}=`, auth: rfc.auth } },
    {
      endpoint: good,
      keys: { p256dh: rfc.uaPublic.replace('_', '/'), auth: rfc.auth },
    },
    {
      endpoint: good,
      keys: { p256dh: base64UrlEncode(offCurve), auth: rfc.auth },
    },
    {
      endpoint: good,
      keys: { p256dh: base64UrlEncode(compressedPrefix), auth: rfc.auth },
    },
    {
      endpoint: good,
      keys: {
        p256dh: base64UrlEncode(bytes(rfc.uaPublic).slice(0, 33)),
        auth: rfc.auth,
      },
    },
    {
      endpoint: good,
      keys: { p256dh: rfc.uaPublic, auth: rfc.auth.slice(0, -2) },
    },
    { endpoint: good, keys: { p256dh: rfc.uaPublic, auth: `${rfc.auth}AA` } },
    { endpoint: good, keys: { p256dh: rfc.uaPublic, auth: rfc.uaPublic } },
  ];
  for (const value of rejected)
    assert.equal(
      await checkPushSubscription(value),
      null,
      JSON.stringify(value)?.slice(0, 120),
    );
  assert.ok(await checkPushSubscription({ endpoint: good, keys }));
});
