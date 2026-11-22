// Scheduled delivery of room notices (issue #14 T3, meeting Q12): pick each
// recipient's current subscriptions, send through T1's sendPush (no retries),
// then drop exactly the rows a push service answered 404·410 for. Runs after
// the room was saved; the caller swallows any error. Log lines carry only
// fixed names, never an endpoint or key.

import { pushPayload, type PushNotice } from './push-notices';
import {
  isPushTargetCurrent,
  listPushTargets,
  removeGonePushSubscription,
  type SqlListDatabase,
} from './push-store';
import { loadVapidKey, type VapidKeyStore } from './vapid-keys';
import { sendPush } from './web-push';

export type PushDispatchDeps = {
  db: SqlListDatabase;
  vapid: VapidKeyStore;
  fetch: typeof fetch;
  // Test-server switch (R9): sign and encrypt, never touch the network.
  blocked: boolean;
  log?: (line: string) => void;
};

export async function dispatchPushNotices(
  notices: readonly PushNotice[],
  deps: PushDispatchDeps,
): Promise<void> {
  const log = deps.log ?? console.log;
  if (!notices.length) return;
  let targets;
  let vapid;
  try {
    targets = await listPushTargets(
      deps.db,
      notices.map((notice) => notice.account),
    );
    if (!targets.length) return;
    vapid = await loadVapidKey(deps.vapid);
  } catch {
    log('WEB_PUSH_DISPATCH_FAILED');
    return;
  }
  await Promise.all(
    notices.map(async (notice) => {
      const mine = targets.filter(
        (target) => target.account === notice.account,
      );
      if (!mine.length) return;
      const deliveries = await sendPush({
        subscriptions: mine,
        roomId: notice.roomId,
        payload: pushPayload(notice),
        vapid,
        fetch: deps.fetch,
        blocked: deps.blocked,
        // The target query may be stale by the time a payload is ready.
        confirm: (index) => isPushTargetCurrent(deps.db, mine[index]),
        log,
      });
      // sendPush keeps the order of `subscriptions`.
      await Promise.all(
        deliveries.map(async (delivery, index) => {
          if (delivery.outcome.kind !== 'gone') return;
          try {
            await removeGonePushSubscription(deps.db, mine[index]);
          } catch {
            log('WEB_PUSH_CLEANUP_FAILED');
          }
        }),
      );
    }),
  );
  // One line per task that reached the send stage (R9 positive control waits
  // for it; tasks with no targets return earlier and log nothing).
  log('WEB_PUSH_DISPATCH_DONE');
}
