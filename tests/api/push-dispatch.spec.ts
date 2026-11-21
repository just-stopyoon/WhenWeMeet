import { randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import {
  addDays,
  test,
  expect,
  today,
  type MeetingRequest,
} from '../support/fixtures';
import type { MeetingResponse } from '../../lib/meeting-contract';
import type { Room } from '../../lib/meeting';

// Issue #14 seam 3, R9 positive control (T3). Only accounts made in this file
// subscribe, each with an endpoint unique to this test; the shared fixture
// accounts never do. The test server blocks the network step, so the Worker
// signs and encrypts in workerd and logs one blocked attempt instead.

const serverLog = join(process.cwd(), 'test-artifacts', 'server.log');
const count = async (marker: string) =>
  (await readFile(serverLog, 'utf8'))
    .split('\n')
    .filter((line) => line.includes(marker)).length;

const base64Url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64url');
async function subscription() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/qa-dispatch-${randomUUID()}`,
    keys: {
      p256dh: base64Url(
        new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)),
      ),
      auth: base64Url(webcrypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

test.describe('Web Push 발송 연결', () => {
  const contexts: APIRequestContext[] = [];
  test.afterAll(async () => {
    await Promise.all(contexts.map((context) => context.dispose()));
  });

  test('구독한 계정이 받는 사람이 되는 전환이면 차단된 시도가 정확히 1줄 는다', async ({
    playwright,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL!;
    const signup = async () => {
      const request = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: baseURL },
      });
      contexts.push(request);
      const name = `pushd${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const response = await request.post('/api/meeting', {
        data: {
          type: 'signup',
          name,
          nickname: name,
          pin: String(1000 + Math.floor(Math.random() * 9000)),
        } satisfies MeetingRequest,
      });
      expect(response.status()).toBe(200);
      return request;
    };
    const post = async (request: APIRequestContext, data: MeetingRequest) => {
      const response = await request.post('/api/meeting', { data });
      expect(response.status(), `${data.type} failed`).toBe(200);
      return (await response.json()) as MeetingResponse<MeetingRequest>;
    };
    // B hosts and subscribes; A submits last and closes the schedule, so the
    // host B is the only recipient (seam 1: schedule → date).
    const hostB = await signup();
    const memberA = await signup();
    const start = today();
    const created = (await post(hostB, {
      type: 'create',
      title: '발송 연결 확인',
      start,
      end: addDays(start, 6),
      size: 2,
      mode: 'all',
    })) as { room: Room };
    const room = created.room;
    await post(memberA, { type: 'join', code: room.code });
    expect(
      await post(hostB, {
        type: 'pushSubscribe',
        subscription: await subscription(),
      }),
    ).toEqual({});
    const slots = [`${start}|저녁`];
    await post(hostB, { type: 'schedule', roomId: room.id, slots });

    const blocked = await count('WEB_PUSH_BLOCKED_ATTEMPT');
    const network = await count('WEB_PUSH_NETWORK_ATTEMPT');
    const closed = (await post(memberA, {
      type: 'schedule',
      roomId: room.id,
      slots,
    })) as { room: Room };
    expect(closed.room.stage).toBe('date');
    await expect
      .poll(() => count('WEB_PUSH_BLOCKED_ATTEMPT'), { timeout: 10_000 })
      .toBe(blocked + 1);
    // Give a duplicate a chance to appear before counting exactly.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await count('WEB_PUSH_BLOCKED_ATTEMPT')).toBe(blocked + 1);
    expect(await count('WEB_PUSH_NETWORK_ATTEMPT')).toBe(network);
  });
});
