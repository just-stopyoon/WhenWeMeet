// Reads and drops a request body that will be rejected anyway (issue #13).
// Under local wrangler dev, an unread body breaks the next request on the
// same connection with a 503; body.cancel() alone did not prevent it.
// Both limits keep the rejection cheap and quick for any body:
// - 64KiB covers the diagnosed sizes (5000B and 20001B made the next request
//   503 in 399/400 runs before) and a body at the 20000-character limit (at
//   most 60000B in UTF-8). A BYOB reader asks only for the bytes left in the
//   budget, so no byte past the limit is read.
// - 1 second bounds a slow or stalled sender.
// On reaching the limit, a timeout or a read error the rest is cancelled; the
// reader is always released. A body that is locked or not a byte stream is
// left alone. The caller answers the same way in every case. Bytes are
// dropped as they arrive; Content-Length is not trusted.
// Past the limit the local 503 on the next request can come back (measured:
// 70000B and 131072B bodies); production Workers have no ProxyWorker.
export const DISCARD_LIMIT_BYTES = 64 * 1024;
export const DISCARD_TIMEOUT_MS = 1000;
const READ_BYTES = 16 * 1024;

export async function discardBody(req: Request): Promise<void> {
  let reader: ReadableStreamBYOBReader;
  try {
    if (!req.body) return;
    reader = req.body.getReader({ mode: 'byob' });
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DISCARD_TIMEOUT_MS);
  });
  let buffer = new ArrayBuffer(READ_BYTES);
  let left = DISCARD_LIMIT_BYTES;
  let ended = false;
  try {
    while (left > 0) {
      const read = reader.read(
        new Uint8Array(buffer, 0, Math.min(left, buffer.byteLength)),
      );
      read.catch(() => {});
      const result = await Promise.race([read, timeout]);
      if (result === 'timeout') break;
      if (result.done) {
        ended = true;
        break;
      }
      left -= result.value.byteLength;
      buffer = result.value.buffer;
    }
  } catch {
    // A read error falls through to the cancel attempt below.
  } finally {
    clearTimeout(timer);
    if (!ended) reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Nothing else to clean up.
    }
  }
}
