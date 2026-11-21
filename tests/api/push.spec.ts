import { randomUUID, webcrypto } from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import {
  test,
  expect,
  expectError,
  type MeetingRequest,
} from '../support/fixtures';
import type { MeetingResponse } from '../../lib/meeting-contract';

// Issue #14 seam 3 (T2). Every subscription here belongs to an account made in
// this file with a unique endpoint; the shared fixture accounts never subscribe.

type Subscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
type Session = { request: APIRequestContext; name: string; pin: string };

const base64Url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64url');

async function receiverKey() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  return base64Url(
    new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)),
  );
}

async function subscription(): Promise<Subscription> {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/qa-${randomUUID()}`,
    keys: {
      p256dh: await receiverKey(),
      auth: base64Url(webcrypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

function expectPublicKey(value: unknown) {
  expect(typeof value).toBe('string');
  expect(value as string).toMatch(/^[A-Za-z0-9_-]+$/);
  const bytes = Buffer.from(value as string, 'base64url');
  expect(bytes.length).toBe(65);
  expect(bytes[0]).toBe(0x04);
}

// No response may carry the private JWK or any part of it.
async function expectNoPrivateKey(response: APIResponse) {
  const text = await response.text();
  for (const marker of ['"d"', '"kty"', '"crv"', 'private', 'jwk'])
    expect(text).not.toContain(marker);
}

test.describe('Web Push 구독 저장', () => {
  const contexts: APIRequestContext[] = [];
  let alice: Session;
  let bob: Session;
  let alicePublicKey: string;

  test.beforeAll(async ({ playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL!;
    const open = async () => {
      const request = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: baseURL },
      });
      contexts.push(request);
      return request;
    };
    const signup = async (): Promise<[Session, string]> => {
      const request = await open();
      const name = `push${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const pin = String(1000 + Math.floor(Math.random() * 9000));
      const response = await request.post('/api/meeting', {
        data: {
          type: 'signup',
          name,
          nickname: name,
          pin,
        } satisfies MeetingRequest,
      });
      expect(response.status()).toBe(200);
      await expectNoPrivateKey(response);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'nickname',
        'pushPublicKey',
        'rooms',
        'user',
      ]);
      expectPublicKey(body.pushPublicKey);
      return [{ request, name, pin }, body.pushPublicKey as string];
    };
    let bobKey: string;
    [alice, alicePublicKey] = await signup();
    [bob, bobKey] = await signup();
    expect(bobKey).toBe(alicePublicKey);
  });

  test.afterAll(async () => {
    await Promise.all(contexts.map((context) => context.dispose()));
  });

  const subscribe = (session: Session, value: unknown) =>
    session.request.post('/api/meeting', {
      data: { type: 'pushSubscribe', subscription: value },
    });
  const unsubscribe = (session: Session, endpoint: unknown) =>
    session.request.post('/api/meeting', {
      data: { type: 'pushUnsubscribe', endpoint },
    });
  async function expectSubscribed(response: APIResponse) {
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    const body = (await response.json()) as MeetingResponse<
      Extract<MeetingRequest, { type: 'pushSubscribe' }>
    >;
    expect(body).toEqual({});
  }
  async function expectRemoved(response: APIResponse, removed: boolean) {
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    const body = (await response.json()) as MeetingResponse<
      Extract<MeetingRequest, { type: 'pushUnsubscribe' }>
    >;
    expect(body).toEqual({ removed });
  }
  async function login(session: Session, request: APIRequestContext) {
    const response = await request.post('/api/meeting', {
      data: {
        type: 'login',
        name: session.name,
        pin: session.pin,
      } satisfies MeetingRequest,
    });
    expect(response.status()).toBe(200);
    return response;
  }

  test('세션이 없으면 401, 다른 Origin이면 403이다', async ({
    playwright,
    baseURL,
  }) => {
    const anonymous = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL! },
    });
    try {
      const value = await subscription();
      await expectError(
        await anonymous.post('/api/meeting', {
          data: { type: 'pushSubscribe', subscription: value },
        }),
        401,
      );
      await expectError(
        await anonymous.post('/api/meeting', {
          data: { type: 'pushUnsubscribe', endpoint: value.endpoint },
        }),
        401,
      );
    } finally {
      await anonymous.dispose();
    }
    const value = await subscription();
    await expectError(
      await alice.request.post('/api/meeting', {
        headers: { Origin: 'http://untrusted.invalid' },
        data: { type: 'pushSubscribe', subscription: value },
      }),
      403,
    );
    await expectError(
      await alice.request.post('/api/meeting', {
        headers: { Origin: 'http://untrusted.invalid' },
        data: { type: 'pushUnsubscribe', endpoint: value.endpoint },
      }),
      403,
    );
    // Neither rejected request stored anything.
    await expectRemoved(await unsubscribe(alice, value.endpoint), false);
  });

  test('구독 검사에 걸리는 구독은 400이고 저장되지 않는다', async () => {
    const valid = await subscription();
    const offCurve = Buffer.alloc(65, 0xff);
    offCurve[0] = 0x04;
    const cases: unknown[] = [
      { ...valid, endpoint: valid.endpoint.replace('https:', 'http:') },
      {
        ...valid,
        endpoint: `https://push.example.com/send/qa-${randomUUID()}`,
      },
      {
        ...valid,
        endpoint: `https://fcm.googleapis.com.example.com/fcm/send/qa-${randomUUID()}`,
      },
      {
        ...valid,
        keys: { ...valid.keys, p256dh: offCurve.toString('base64url') },
      },
      {
        ...valid,
        keys: { ...valid.keys, auth: base64Url(new Uint8Array(15)) },
      },
      null,
      [],
      'subscription',
    ];
    for (const value of cases)
      await expectError(await subscribe(alice, value), 400, /알림/);
    for (const endpoint of [
      valid.endpoint.replace('https:', 'http:'),
      valid.endpoint.replace('fcm.googleapis.com', 'FCM.googleapis.com'),
      42,
      null,
      '',
    ])
      await expectError(await unsubscribe(alice, endpoint), 400, /알림/);
    await expectRemoved(await unsubscribe(alice, valid.endpoint), false);
  });

  test('등록·해지 응답에는 room이 없고 지금 계정의 행만 지운다', async () => {
    const value = await subscription();
    await expectSubscribed(await subscribe(alice, value));
    // Registering again with the same values is accepted (re-sync).
    await expectSubscribed(await subscribe(alice, value));
    await expectRemoved(await unsubscribe(bob, value.endpoint), false);
    await expectRemoved(await unsubscribe(alice, value.endpoint), true);
    await expectRemoved(await unsubscribe(alice, value.endpoint), false);
  });

  test('다른 계정이 p256dh만 다르게 등록하면 400이고 원래 행이 남는다', async () => {
    const value = await subscription();
    await expectSubscribed(await subscribe(alice, value));
    await expectError(
      await subscribe(bob, {
        ...value,
        keys: { ...value.keys, p256dh: await receiverKey() },
      }),
      400,
      /알림/,
    );
    await expectRemoved(await unsubscribe(bob, value.endpoint), false);
    await expectRemoved(await unsubscribe(alice, value.endpoint), true);
  });

  test('다른 계정이 auth만 다르게 등록하면 400이고 원래 행이 남는다', async () => {
    const value = await subscription();
    await expectSubscribed(await subscribe(alice, value));
    await expectError(
      await subscribe(bob, {
        ...value,
        keys: {
          ...value.keys,
          auth: base64Url(webcrypto.getRandomValues(new Uint8Array(16))),
        },
      }),
      400,
      /알림/,
    );
    await expectRemoved(await unsubscribe(bob, value.endpoint), false);
    await expectRemoved(await unsubscribe(alice, value.endpoint), true);
  });

  test('다른 계정이 키 둘 다 같게 등록하면 그 계정으로 옮긴다', async () => {
    const value = await subscription();
    await expectSubscribed(await subscribe(alice, value));
    await expectSubscribed(await subscribe(bob, value));
    await expectRemoved(await unsubscribe(alice, value.endpoint), false);
    await expectRemoved(await unsubscribe(bob, value.endpoint), true);
  });

  test('logout은 그 세션의 구독만 지우고 끝난 세션의 등록은 401이다', async ({
    playwright,
    baseURL,
  }) => {
    const first = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL! },
    });
    const second = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL! },
    });
    try {
      const s1 = { ...alice, request: first };
      const s2 = { ...alice, request: second };
      const loggedIn = await login(alice, first);
      await expectNoPrivateKey(loggedIn);
      const loginBody = (await loggedIn.json()) as Record<string, unknown>;
      expect(Object.keys(loginBody).sort()).toEqual([
        'nickname',
        'pushPublicKey',
        'rooms',
        'user',
      ]);
      expect(loginBody.pushPublicKey).toBe(alicePublicKey);
      await login(alice, second);
      const fromS1 = await subscription();
      const fromS2 = await subscription();
      await expectSubscribed(await subscribe(s1, fromS1));
      await expectSubscribed(await subscribe(s2, fromS2));
      const logout = await first.post('/api/meeting', {
        data: { type: 'logout' } satisfies MeetingRequest,
      });
      expect(logout.status()).toBe(200);
      expect(await logout.json()).toEqual({});
      await expectError(await subscribe(s1, await subscription()), 401);
      await expectError(await subscribe(s1, fromS1), 401);
      await expectRemoved(await unsubscribe(s2, fromS1.endpoint), false);
      await expectRemoved(await unsubscribe(s2, fromS2.endpoint), true);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  test('로그인 GET의 공개 키는 계정·세션이 달라도 같고 비공개 키는 없다', async ({
    playwright,
    baseURL,
  }) => {
    for (const session of [alice, bob]) {
      const response = await session.request.get('/api/meeting');
      expect(response.status()).toBe(200);
      await expectNoPrivateKey(response);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'nickname',
        'pushPublicKey',
        'rooms',
        'user',
      ]);
      expect(body.user).toBe(session.name);
      expectPublicKey(body.pushPublicKey);
      expect(body.pushPublicKey).toBe(alicePublicKey);
    }
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const response = await anonymous.get('/api/meeting');
      expect(await response.json()).toEqual({ user: '', rooms: [] });
    } finally {
      await anonymous.dispose();
    }
  });
});
