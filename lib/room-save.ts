// The room save loop (issue #14 T3, R7 ①): up to eight version-conditional
// UPDATEs, each on a fresh read. Row reads, the UPDATE, delivery and scheduling
// are injected; the API route passes D1 and `waitUntil`, so this module never
// imports `cloudflare:workers` and runs in unit tests.

import type { Room } from './meeting';
import { pushNotices, type PushNotice } from './push-notices';
import { applyAction, type UnvalidatedAction } from './room-actions';

export type RoomRow = { id: string; data: string; version: number };

export type RoomSaveDeps = {
  read(): Promise<RoomRow | null>;
  // true when the row still had `row.version` and now holds `updated`.
  update(row: RoomRow, updated: Room): Promise<boolean>;
  dispatch(notices: PushNotice[]): Promise<void>;
  // Keeps the task alive after the response (`waitUntil`); never awaited.
  schedule(task: Promise<void>): void;
  log?: (line: string) => void;
};

export const roomSaveAttempts = 8;

// What the API route replies when saveRoomAction returns null.
export const roomSaveConflict = {
  status: 409,
  body: { error: '다른 친구가 제출 중이에요. 한 번 더 시도해 주세요.' },
} as const;

// Returns the saved room, or null when every attempt lost the version race.
// Errors from the read or applyAction() reach the caller unchanged.
export async function saveRoomAction(
  deps: RoomSaveDeps,
  user: string,
  action: UnvalidatedAction,
): Promise<Room | null> {
  for (let attempt = 0; attempt < roomSaveAttempts; attempt++) {
    const row = await deps.read();
    if (!row)
      throw new Error('모임을 찾을 수 없어요. 초대 코드를 확인해 주세요.');
    const before = JSON.parse(row.data) as Room;
    const updated = applyAction(before, user, action);
    if (!(await deps.update(row, updated))) continue;
    // Only the winning attempt's own before/after decide the notices, and
    // nothing is sent before the UPDATE has succeeded.
    // The room is saved: preparing or scheduling notices must not turn this
    // into an error the user would retry (Q12).
    try {
      const notices = pushNotices(before, updated, user);
      if (notices.length) deps.schedule(deliverQuietly(deps, notices));
    } catch {
      logQuietly(deps);
    }
    return updated;
  }
  return null;
}

// Delivery never affects the action: failures become one fixed log line
// (no endpoint, key or message) and the scheduled promise never rejects.
async function deliverQuietly(deps: RoomSaveDeps, notices: PushNotice[]) {
  try {
    await deps.dispatch(notices);
  } catch {
    logQuietly(deps);
  }
}

function logQuietly(deps: RoomSaveDeps) {
  try {
    (deps.log ?? console.warn)('WEB_PUSH_DISPATCH_FAILED');
  } catch {
    // Logging must not reject the scheduled task or the save either.
  }
}
