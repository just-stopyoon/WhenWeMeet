// Reads and drops a request body that will be rejected anyway (issue #13).
// Under local wrangler dev, an unread body breaks the next request on the
// same connection with a 503; body.cancel() alone did not prevent it.
// Both limits keep the rejection cheap and quick for any body:
// - 64KiB covers the diagnosed sizes (5000B and 20001B always failed before)
//   and a body at the 20000-character limit (at most 60000B in UTF-8).
// - 1 second bounds a slow or stalled sender.
// On a limit or a read error the rest is cancelled and the caller answers as
// before. Chunks are dropped as they arrive; Content-Length is not trusted.
// Past a limit the local 503 on the next request can come back (measured:
// 70000B and 131072B bodies); production Workers have no ProxyWorker.
export const DISCARD_LIMIT_BYTES = 64 * 1024;
export const DISCARD_TIMEOUT_MS = 1000;

export async function discardBody(req: Request): Promise<void> {
  const reader = req.body?.getReader();
  if (!reader) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DISCARD_TIMEOUT_MS);
  });
  let read = 0;
  try {
    while (read <= DISCARD_LIMIT_BYTES) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === 'timeout') break;
      if (chunk.done) return;
      read += chunk.value.byteLength;
    }
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
  void reader.cancel().catch(() => {});
}
