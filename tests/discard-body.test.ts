import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DISCARD_LIMIT_BYTES,
  DISCARD_TIMEOUT_MS,
  discardBody,
} from '../lib/discard-body';

const CHUNK = 1024;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function source(next: (pulled: number) => Promise<Uint8Array | null>) {
  const state = { pulled: 0, cancelled: false, closed: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await next(state.pulled);
      if (!chunk) {
        state.closed = true;
        controller.close();
        return;
      }
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const req = new Request('http://local.test/api/meeting', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  return { req, state };
}

void test('본문이 없으면 바로 끝난다', async () => {
  await discardBody(
    new Request('http://local.test/api/meeting', { method: 'POST' }),
  );
});

void test('상한 아래 본문은 끝까지 읽고 취소하지 않는다', async () => {
  const { req, state } = source(async (pulled) =>
    pulled < 20001 ? new Uint8Array(Math.min(CHUNK, 20001 - pulled)) : null,
  );
  await discardBody(req);
  assert.equal(state.pulled, 20001);
  assert.equal(state.closed, true);
  assert.equal(state.cancelled, false);
});

void test(
  '상한보다 큰 본문은 바이트 상한에서 멈추고 취소한다',
  { timeout: 5000 },
  async () => {
    // Ends after 1MiB only so a broken helper fails instead of hanging.
    const { req, state } = source(async (pulled) =>
      pulled < 1024 * CHUNK ? new Uint8Array(CHUNK) : null,
    );
    const started = Date.now();
    await discardBody(req);
    await wait(0);
    assert.ok(state.pulled > DISCARD_LIMIT_BYTES, `pulled=${state.pulled}`);
    assert.equal(state.closed, false);
    assert.ok(
      state.pulled <= DISCARD_LIMIT_BYTES + 8 * CHUNK,
      `pulled=${state.pulled}`,
    );
    assert.ok(Date.now() - started < DISCARD_TIMEOUT_MS);
    assert.equal(state.cancelled, true);
  },
);

void test(
  '멈춘 본문은 시간 상한에서 끝나고 취소한다',
  { timeout: 5000 },
  async () => {
    const { req, state } = source(async (pulled) =>
      pulled === 0 ? new Uint8Array(1) : new Promise<null>(() => {}),
    );
    const started = Date.now();
    await discardBody(req);
    const elapsed = Date.now() - started;
    await wait(0);
    assert.ok(elapsed >= DISCARD_TIMEOUT_MS - 50, `elapsed=${elapsed}`);
    assert.ok(elapsed < DISCARD_TIMEOUT_MS + 1000, `elapsed=${elapsed}`);
    assert.equal(state.cancelled, true);
  },
);

void test('읽기 오류는 밖으로 던지지 않는다', { timeout: 5000 }, async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
      controller.error(new Error('broken'));
    },
  });
  await discardBody(
    new Request('http://local.test/api/meeting', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit),
  );
});
