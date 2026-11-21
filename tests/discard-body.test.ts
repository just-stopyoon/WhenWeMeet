import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DISCARD_LIMIT_BYTES,
  DISCARD_TIMEOUT_MS,
  discardBody,
} from '../lib/discard-body';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const post = (body?: ReadableStream) =>
  new Request('http://local.test/api/meeting', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);

// A byte source that writes straight into the reader's view, so `delivered`
// is exactly what discardBody asked for. `next` returns how many bytes it may
// still give (Infinity: endless, 0: end, null: stall).
function byteSource(next: (delivered: number) => number | null) {
  const state = { delivered: 0, cancelled: false, closed: false };
  const body = new ReadableStream({
    type: 'bytes',
    async pull(controller: ReadableByteStreamController) {
      const available = next(state.delivered);
      if (available === null) return new Promise<void>(() => {});
      if (available <= 0) {
        state.closed = true;
        controller.close();
        controller.byobRequest?.respond(0);
        return;
      }
      const request = controller.byobRequest;
      if (!request?.view) throw new Error('expected a BYOB read');
      const size = Math.min(request.view.byteLength, available);
      state.delivered += size;
      request.respond(size);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { req: post(body), state };
}

void test('본문이 없으면 바로 끝난다', async () => {
  await discardBody(post());
});

void test('상한 아래 본문은 끝까지 읽고 취소하지 않으며 잠금을 푼다', async () => {
  const { req, state } = byteSource((delivered) => 20001 - delivered);
  await discardBody(req);
  assert.equal(state.delivered, 20001);
  assert.equal(state.closed, true);
  assert.equal(state.cancelled, false);
  assert.equal(req.body?.locked, false);
});

void test(
  '정확히 상한만큼 읽고 바로 멈춘 뒤 취소하고 잠금을 푼다',
  { timeout: 5000 },
  async () => {
    // The sender keeps the body open after exactly the limit: discardBody must
    // not ask for more and must not wait for the timeout.
    const { req, state } = byteSource((delivered) =>
      delivered < DISCARD_LIMIT_BYTES ? DISCARD_LIMIT_BYTES - delivered : null,
    );
    const started = Date.now();
    await discardBody(req);
    const elapsed = Date.now() - started;
    await wait(0);
    assert.equal(state.delivered, DISCARD_LIMIT_BYTES);
    assert.ok(elapsed < DISCARD_TIMEOUT_MS / 2, `elapsed=${elapsed}`);
    assert.equal(state.cancelled, true);
    assert.equal(req.body?.locked, false);
  },
);

void test(
  '상한보다 큰 본문도 상한 바이트까지만 읽고 취소한다',
  { timeout: 5000 },
  async () => {
    // Ends after 1MiB only so a broken helper fails instead of hanging.
    const { req, state } = byteSource((delivered) => 1024 * 1024 - delivered);
    await discardBody(req);
    await wait(0);
    assert.equal(state.delivered, DISCARD_LIMIT_BYTES);
    assert.equal(state.closed, false);
    assert.equal(state.cancelled, true);
    assert.equal(req.body?.locked, false);
  },
);

void test(
  '멈춘 본문은 시간 상한에서 끝나고 취소하며 잠금을 푼다',
  { timeout: 5000 },
  async () => {
    const { req, state } = byteSource((delivered) =>
      delivered === 0 ? 1 : null,
    );
    const started = Date.now();
    await discardBody(req);
    const elapsed = Date.now() - started;
    await wait(0);
    assert.ok(elapsed >= DISCARD_TIMEOUT_MS - 50, `elapsed=${elapsed}`);
    assert.ok(elapsed < DISCARD_TIMEOUT_MS + 1000, `elapsed=${elapsed}`);
    assert.equal(state.delivered, 1);
    assert.equal(state.cancelled, true);
    assert.equal(req.body?.locked, false);
  },
);

void test('읽기 오류는 밖으로 던지지 않고 잠금을 푼다', async () => {
  const body = new ReadableStream({
    type: 'bytes',
    start(controller: ReadableByteStreamController) {
      controller.enqueue(new Uint8Array(10));
      controller.error(new Error('broken'));
    },
  });
  const req = post(body);
  await discardBody(req);
  assert.equal(req.body?.locked, false);
});

void test('이미 잠긴 본문은 건드리지 않고 끝난다', async () => {
  const { req, state } = byteSource((delivered) => 100 - delivered);
  const other = req.body!.getReader();
  await discardBody(req);
  assert.equal(state.delivered, 0);
  assert.equal(req.body?.locked, true);
  other.releaseLock();
  assert.equal(req.body?.locked, false);
});

void test('바이트 스트림이 아닌 본문은 건드리지 않고 끝난다', async () => {
  let pulled = 0;
  const req = post(
    new ReadableStream({
      pull(controller: ReadableStreamDefaultController<Uint8Array>) {
        pulled += 1;
        controller.enqueue(new Uint8Array(10));
      },
    }),
  );
  await discardBody(req);
  assert.equal(req.body?.locked, false);
  assert.ok(pulled <= 1, `pulled=${pulled}`);
});
