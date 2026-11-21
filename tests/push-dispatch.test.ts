import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { newRoom, type Room } from '../lib/meeting';
import { dispatchPushNotices } from '../lib/push-dispatch';
import type { PushNotice } from '../lib/push-notices';
import {
  d1VapidKeyStore,
  savePushSubscription,
  type SqlListDatabase,
  type SqlListStatement,
} from '../lib/push-store';
import { base64UrlEncode } from '../lib/push-subscription';
import {
  roomSaveConflict,
  saveRoomAction,
  type RoomRow,
} from '../lib/room-save';

// Issue #14 seam 2 (T3, R7 ①): the room save loop with injected row reads,
// conditional UPDATE and scheduling, and the scheduled work run against the
// real target selection and cleanup on an isolated SQLite stand-in (the real
// migration files, foreign keys on) with a recording `fetch`. No test here
// reaches a real push service.

// ---------------------------------------------------------------- save loop

const slot = '2099-12-03|저녁';
const members = ['host', 'friend', 'other'];
function room(overrides: Partial<Room> = {}): Room {
  return {
    ...newRoom('모임', 'host', '2099-12-01', '2099-12-14', 3, 'all', 'room-1'),
    members: [...members],
    ...overrides,
  };
}
// `friend` submitting last closes the schedule: the host gets one notice.
const closing = () => room({ responses: { host: [slot], other: [slot] } });
// Still waiting for `other`: friend's submission changes no stage.
const waiting = () => room({ responses: { host: [slot] } });
const row = (data: Room, version: number): RoomRow => ({
  id: data.id,
  data: JSON.stringify(data),
  version,
});

type Events = string[];
function loop(
  reads: (RoomRow | null)[],
  updates: boolean[],
  dispatch: (notices: PushNotice[]) => Promise<void> = async () => {},
) {
  const events: Events = [];
  const scheduled: Promise<void>[] = [];
  const dispatched: PushNotice[][] = [];
  const updatedStates: Room[] = [];
  const logs: string[] = [];
  let read = 0;
  let update = 0;
  const deps = {
    read: async () => {
      events.push(`read ${read}`);
      return reads[read++] ?? null;
    },
    update: async (current: RoomRow, updated: Room) => {
      events.push(`update v${current.version}`);
      updatedStates.push(updated);
      return updates[update++] ?? false;
    },
    dispatch: (notices: PushNotice[]) => {
      events.push('dispatch');
      dispatched.push(notices);
      return dispatch(notices);
    },
    schedule: (task: Promise<void>) => {
      events.push('schedule');
      scheduled.push(task);
    },
    log: (line: string) => logs.push(line),
  };
  return { deps, events, scheduled, dispatched, updatedStates, logs };
}
const submit = { type: 'schedule', roomId: 'room-1', slots: [slot] };

void test('행이 없으면 기존 오류 그대로이고 예약하지 않는다', async () => {
  const run = loop([null], []);
  await assert.rejects(
    saveRoomAction(run.deps, 'friend', submit),
    /^Error: 모임을 찾을 수 없어요. 초대 코드를 확인해 주세요.$/,
  );
  assert.equal(run.scheduled.length, 0);
  assert.equal(run.dispatched.length, 0);
});

void test('applyAction()의 권한·상태 실패는 기존 오류 그대로이고 예약하지 않는다', async () => {
  const permission = loop([row(room({ stage: 'tie', tied: ['a'] }), 1)], []);
  await assert.rejects(
    saveRoomAction(permission.deps, 'friend', {
      type: 'runoff',
      roomId: 'room-1',
    }),
    /^Error: 방장만 할 수 있어요.$/,
  );
  const state = loop([row(room({ stage: 'final' }), 1)], []);
  await assert.rejects(
    saveRoomAction(state.deps, 'friend', submit),
    /^Error: 지금은 이 작업을 할 수 없어요.$/,
  );
  for (const run of [permission, state]) {
    assert.equal(run.scheduled.length, 0);
    assert.deepEqual(
      run.events.filter((event) => event.startsWith('update')),
      [],
    );
  }
});

void test('충돌 몇 번 뒤 성공하면 성공한 시도의 전·후 상태로 한 번만 예약한다', async () => {
  // Attempts 1–2 read a room where friend's submission would not close the
  // schedule; attempt 3 reads the room where it does and its UPDATE wins.
  const run = loop(
    [row(waiting(), 1), row(waiting(), 2), row(closing(), 3)],
    [false, false, true],
  );
  const saved = await saveRoomAction(run.deps, 'friend', submit);
  assert.equal(saved?.stage, 'date');
  assert.deepEqual(saved, run.updatedStates[2]);
  assert.equal(run.scheduled.length, 1);
  assert.deepEqual(run.dispatched, [
    [
      {
        account: 'host',
        title: '모임',
        body: '모두 일정을 제출했어요. 날짜를 정해 주세요.',
        roomId: 'room-1',
        url: '/?room=room-1',
      },
    ],
  ]);
  // Scheduling happens only after the winning UPDATE, never inside a lost try.
  assert.deepEqual(run.events, [
    'read 0',
    'update v1',
    'read 1',
    'update v2',
    'read 2',
    'update v3',
    'dispatch',
    'schedule',
  ]);
});

void test('충돌 시도의 전·후 상태로는 예약하지 않는다', async () => {
  // A lost attempt that would have closed the schedule must not notify.
  const run = loop([row(closing(), 1), row(waiting(), 2)], [false, true]);
  const saved = await saveRoomAction(run.deps, 'friend', submit);
  assert.equal(saved?.stage, 'schedule');
  assert.equal(run.scheduled.length, 0);
  assert.equal(run.dispatched.length, 0);
});

void test('8회 모두 충돌하면 예약하지 않고 충돌 결과를 돌려준다', async () => {
  const run = loop(
    Array.from({ length: 9 }, (_, index) => row(closing(), index)),
    Array.from({ length: 9 }, () => false),
  );
  assert.equal(await saveRoomAction(run.deps, 'friend', submit), null);
  assert.equal(
    run.events.filter((event) => event.startsWith('update')).length,
    8,
  );
  assert.equal(run.scheduled.length, 0);
  assert.equal(run.dispatched.length, 0);
});

void test('성공한 저장이 전환을 만들지 않으면 예약하지 않는다', async () => {
  const run = loop([row(waiting(), 1)], [true]);
  assert.equal(
    (await saveRoomAction(run.deps, 'friend', submit))?.stage,
    'schedule',
  );
  assert.equal(run.scheduled.length, 0);
});

void test('예약한 작업이 끝나지 않아도 저장 결과가 먼저 나온다', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => (finish = resolve));
  const run = loop([row(closing(), 1)], [true], () => pending);
  const outcome = await Promise.race([
    saveRoomAction(run.deps, 'friend', submit).then((saved) => saved?.stage),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000)),
  ]);
  assert.equal(outcome, 'date');
  let settled = false;
  void run.scheduled[0].then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  finish();
  await run.scheduled[0];
  assert.equal(settled, true);
});

void test('예약한 작업이 실패해도 저장 결과는 그대로 성공이고 예약은 거절되지 않는다', async () => {
  const rejecting = loop([row(closing(), 1)], [true], () =>
    Promise.reject(new Error('https://fcm.googleapis.com/secret')),
  );
  const throwing = loop([row(closing(), 1)], [true], () => {
    throw new Error('https://fcm.googleapis.com/secret');
  });
  for (const run of [rejecting, throwing]) {
    assert.equal(
      (await saveRoomAction(run.deps, 'friend', submit))?.stage,
      'date',
    );
    assert.equal(run.scheduled.length, 1);
    await run.scheduled[0];
    assert.deepEqual(run.logs, ['WEB_PUSH_DISPATCH_FAILED']);
  }
});

void test('8회 충돌은 라우트가 그대로 내는 409와 기존 문구로 바뀐다', async () => {
  const run = loop(
    Array.from({ length: 8 }, (_, index) => row(waiting(), index)),
    Array.from({ length: 8 }, () => false),
  );
  assert.equal(await saveRoomAction(run.deps, 'friend', submit), null);
  // app/api/meeting/route.ts replies `{ error }` with this status on null.
  assert.deepEqual(roomSaveConflict, {
    status: 409,
    body: { error: '다른 친구가 제출 중이에요. 한 번 더 시도해 주세요.' },
  });
});

void test('알림 예약이 동기 예외를 던져도 이미 저장된 방을 돌려주고 고정 한 줄만 기록한다', async () => {
  const run = loop([row(closing(), 1)], [true]);
  const deps = {
    ...run.deps,
    schedule: () => {
      throw new Error('https://fcm.googleapis.com/secret');
    },
  };
  assert.equal((await saveRoomAction(deps, 'friend', submit))?.stage, 'date');
  assert.deepEqual(run.logs, ['WEB_PUSH_DISPATCH_FAILED']);
});

// ----------------------------------------------------- dispatch on SQLite

const migrations = [
  '0000_shared_rooms.sql',
  '0001_account_profiles.sql',
  '0002_push_subscriptions.sql',
];

type Fault = (query: string) => void;
function database(files = migrations, fault: Fault = () => {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of files)
    sqlite.exec(readFileSync(join(process.cwd(), 'drizzle', file), 'utf8'));
  const statement = (
    query: string,
    values: unknown[] = [],
  ): SqlListStatement => ({
    bind: (...next: unknown[]) => statement(query, next),
    first: async <T>() => {
      fault(query);
      const found = sqlite.prepare(query).get(...(values as never[]));
      return (found ? { ...found } : null) as T | null;
    },
    all: async <T>() => {
      fault(query);
      return {
        results: sqlite
          .prepare(query)
          .all(...(values as never[]))
          .map((entry) => ({ ...entry })) as T[],
      };
    },
    run: async () => {
      fault(query);
      return {
        meta: {
          changes: Number(
            sqlite.prepare(query).run(...(values as never[])).changes,
          ),
        },
      };
    },
  });
  const db: SqlListDatabase = { prepare: (query) => statement(query) };
  return { sqlite, db };
}

function addSession(
  sqlite: DatabaseSync,
  account: string,
  token: string,
  expires = Date.now() + 86_400_000,
) {
  sqlite
    .prepare('INSERT OR IGNORE INTO accounts(name,salt,hash) VALUES(?,?,?)')
    .run(account, 's', 'h');
  sqlite
    .prepare('INSERT INTO sessions(token,name,expires) VALUES(?,?,?)')
    .run(token, account, expires);
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  return {
    p256dh: base64UrlEncode(
      new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    ),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}
async function subscribe(
  db: SqlListDatabase,
  session: string,
  name: string,
  values?: { p256dh: string; auth: string },
) {
  const record = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    ...(values ?? (await keys())),
  };
  assert.equal(await savePushSubscription(db, session, record), 'saved');
  return record;
}

const generations = (sqlite: DatabaseSync) =>
  Object.fromEntries(
    sqlite
      .prepare(
        'SELECT endpoint, generation FROM push_subscriptions ORDER BY endpoint',
      )
      .all()
      .map((entry) => [String(entry.endpoint), String(entry.generation)]),
  );

const notice = (account: string): PushNotice => ({
  account,
  title: '모임',
  body: '모두 일정을 제출했어요. 날짜를 정해 주세요.',
  roomId: 'room-1',
  url: '/?room=room-1',
});

type Responder = (endpoint: string) => number | Promise<number>;
function dispatcher(db: SqlListDatabase, respond: Responder, blocked = false) {
  const sent: string[] = [];
  const logs: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const endpoint = String(input as string);
    sent.push(endpoint);
    return new Response(null, { status: await respond(endpoint) });
  }) as typeof globalThis.fetch;
  const run = (notices: PushNotice[]) =>
    dispatchPushNotices(notices, {
      db,
      vapid: d1VapidKeyStore(db),
      fetch,
      blocked,
      log: (line) => logs.push(line),
    });
  return { run, sent, logs };
}

void test('받는 계정의 유효한 세션 구독에만 보낸다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'host', 'h1');
  addSession(sqlite, 'host', 'h2');
  addSession(sqlite, 'friend', 'f1');
  const a = await subscribe(db, 'h1', 'host-a');
  const b = await subscribe(db, 'h2', 'host-b');
  await subscribe(db, 'f1', 'friend-a');
  const send = dispatcher(db, () => 201);
  await send.run([notice('host')]);
  assert.deepEqual([...send.sent].sort(), [a.endpoint, b.endpoint].sort());
});

for (const status of [404, 410])
  void test(`그대로인 행에 ${status}이면 그 행을 지운다`, async () => {
    const { sqlite, db } = database();
    addSession(sqlite, 'host', 'h1');
    const gone = await subscribe(db, 'h1', 'gone');
    const kept = await subscribe(db, 'h1', 'kept');
    const send = dispatcher(db, (endpoint) =>
      endpoint === gone.endpoint ? status : 201,
    );
    await send.run([notice('host')]);
    assert.deepEqual(Object.keys(generations(sqlite)), [kept.endpoint]);
  });

void test('404·410 밖의 결과는 지우지 않는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'host', 'h1');
  const statuses: Record<string, number> = {};
  for (const [name, status] of [
    ['s201', 201],
    ['s301', 301],
    ['s403', 403],
    ['s500', 500],
  ] as const)
    statuses[(await subscribe(db, 'h1', name)).endpoint] = status;
  const before = generations(sqlite);
  const send = dispatcher(db, (endpoint) => statuses[endpoint]);
  await send.run([notice('host')]);
  assert.equal(send.sent.length, 4);
  assert.deepEqual(generations(sqlite), before);
});

// While the push service holds the request, the row is written again; the
// late 404·410 belongs to the row that was read, not to the rewritten one.
const rewrites: [
  string,
  (db: SqlListDatabase, sqlite: DatabaseSync) => Promise<void>,
][] = [
  [
    '같은 세션에서 지운 뒤 같은 값으로 다시 등록',
    async (db, sqlite) => {
      const old = sqlite
        .prepare('SELECT endpoint,p256dh,auth FROM push_subscriptions')
        .get()!;
      sqlite.prepare('DELETE FROM push_subscriptions').run();
      assert.equal(
        await savePushSubscription(db, 'h1', {
          endpoint: String(old.endpoint),
          p256dh: String(old.p256dh),
          auth: String(old.auth),
        }),
        'saved',
      );
    },
  ],
  [
    '다른 세션으로 같은 값 다시 등록',
    async (db, sqlite) => {
      addSession(sqlite, 'host', 'h2');
      const old = sqlite
        .prepare('SELECT endpoint,p256dh,auth FROM push_subscriptions')
        .get()!;
      assert.equal(
        await savePushSubscription(db, 'h2', {
          endpoint: String(old.endpoint),
          p256dh: String(old.p256dh),
          auth: String(old.auth),
        }),
        'saved',
      );
    },
  ],
  [
    '계정 이동',
    async (db, sqlite) => {
      addSession(sqlite, 'friend', 'f1');
      const old = sqlite
        .prepare('SELECT endpoint,p256dh,auth FROM push_subscriptions')
        .get()!;
      assert.equal(
        await savePushSubscription(db, 'f1', {
          endpoint: String(old.endpoint),
          p256dh: String(old.p256dh),
          auth: String(old.auth),
        }),
        'saved',
      );
    },
  ],
];
for (const [name, rewrite] of rewrites)
  for (const status of [404, 410])
    void test(`${name} 뒤 늦은 ${status}이면 행이 남는다`, async () => {
      const { sqlite, db } = database();
      addSession(sqlite, 'host', 'h1');
      const record = await subscribe(db, 'h1', 'device');
      const read = generations(sqlite)[record.endpoint];
      const send = dispatcher(db, async () => {
        await rewrite(db, sqlite);
        return status;
      });
      await send.run([notice('host')]);
      const after = generations(sqlite);
      assert.deepEqual(Object.keys(after), [record.endpoint]);
      assert.notEqual(after[record.endpoint], read);
    });

void test('등록 세션이 발송 전에 만료·logout되면 그 구독에는 보내지 않는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'host', 'valid');
  addSession(sqlite, 'host', 'expiring');
  addSession(sqlite, 'host', 'leaving');
  const valid = await subscribe(db, 'valid', 'valid');
  await subscribe(db, 'expiring', 'expiring');
  await subscribe(db, 'leaving', 'leaving');
  // Expired but not yet swept by initialize(): the row is still there.
  sqlite
    .prepare('UPDATE sessions SET expires=? WHERE token=?')
    .run(Date.now() - 1, 'expiring');
  sqlite.prepare('DELETE FROM sessions WHERE token=?').run('leaving');
  const send = dispatcher(db, () => 201);
  await send.run([notice('host')]);
  assert.deepEqual(send.sent, [valid.endpoint]);
});

void test('세션이 다른 계정의 것이면 그 구독에는 보내지 않는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'host', 'h1');
  addSession(sqlite, 'friend', 'f1');
  await subscribe(db, 'h1', 'device');
  // A row whose session belongs to someone else is not the account's device.
  sqlite.prepare('UPDATE push_subscriptions SET session=?').run('f1');
  const send = dispatcher(db, () => 201);
  await send.run([notice('host')]);
  assert.deepEqual(send.sent, []);
});

// Between the target query and the network call (here: while the VAPID key
// is read) the device moves to another account, logs out or expires. The
// check right before sending must skip it, in blocked mode too.
const changes: [string, (sqlite: DatabaseSync) => void][] = [
  [
    '다른 계정으로 이동',
    (sqlite) =>
      sqlite
        .prepare(
          "UPDATE push_subscriptions SET account_id='friend', session='f1', generation='moved'",
        )
        .run(),
  ],
  [
    'logout',
    (sqlite) => sqlite.prepare("DELETE FROM sessions WHERE token='h1'").run(),
  ],
  [
    '세션 만료',
    (sqlite) =>
      sqlite
        .prepare("UPDATE sessions SET expires=? WHERE token='h1'")
        .run(Date.now() - 1),
  ],
];
for (const [name, change] of changes)
  for (const blocked of [false, true])
    void test(`대상 조회 뒤 ${name}되면 보내기 직전 확인에서 건너뛴다${blocked ? '(차단 모드)' : ''}`, async () => {
      let pending = true;
      const holder: { sqlite?: DatabaseSync } = {};
      const made = database(migrations, (query) => {
        if (pending && holder.sqlite && /FROM push_vapid_keys/.test(query)) {
          pending = false;
          change(holder.sqlite);
        }
      });
      const sqlite = (holder.sqlite = made.sqlite);
      addSession(sqlite, 'host', 'h1');
      addSession(sqlite, 'friend', 'f1');
      await subscribe(made.db, 'h1', 'device');
      const send = dispatcher(made.db, () => 201, blocked);
      await send.run([notice('host')]);
      assert.equal(pending, false, 'the change ran');
      assert.deepEqual(send.sent, []);
      assert.ok(
        send.logs.every((line) => !line.startsWith('WEB_PUSH_BLOCKED_ATTEMPT')),
      );
      assert.ok(send.logs.includes('WEB_PUSH_RESULT stale'));
    });

void test('보내기 직전 확인이 실패하면 보내지 않는다', async () => {
  const made = database(migrations, (query) => {
    if (/AND push_subscriptions\.generation=/.test(query))
      throw new Error('D1_ERROR https://fcm.googleapis.com/fcm/send/secret');
  });
  addSession(made.sqlite, 'host', 'h1');
  await subscribe(made.db, 'h1', 'device');
  const send = dispatcher(made.db, () => 201);
  await send.run([notice('host')]);
  assert.deepEqual(send.sent, []);
  assert.ok(send.logs.every((line) => !line.includes('https://')));
});

void test('발송 차단 중이면 네트워크로 나가지 않고 행도 지우지 않는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'host', 'h1');
  await subscribe(db, 'h1', 'device');
  const before = generations(sqlite);
  const send = dispatcher(db, () => 410, true);
  await send.run([notice('host')]);
  assert.deepEqual(send.sent, []);
  assert.deepEqual(send.logs, [
    'WEB_PUSH_BLOCKED_ATTEMPT host=fcm',
    'WEB_PUSH_RESULT blocked',
    'WEB_PUSH_DISPATCH_DONE',
  ]);
  assert.deepEqual(generations(sqlite), before);
});

void test('대상 조회가 실패하면 고정 한 줄만 기록하고 보내지 않는다', async () => {
  const failing = database(migrations, (query) => {
    if (/FROM push_subscriptions/.test(query) && /^\s*SELECT/.test(query))
      throw new Error('D1_ERROR https://fcm.googleapis.com/fcm/send/secret');
  });
  addSession(failing.sqlite, 'host', 'h1');
  await subscribe(failing.db, 'h1', 'device');
  const missing = database(migrations.slice(0, 2));
  for (const { db } of [failing, missing]) {
    const send = dispatcher(db, () => 201);
    await send.run([notice('host')]);
    assert.deepEqual(send.sent, []);
    assert.deepEqual(send.logs, ['WEB_PUSH_DISPATCH_FAILED']);
  }
});

void test('한 행 삭제가 실패해도 다른 404·410 행은 지운다', async () => {
  let failNext = true;
  const { sqlite, db } = database(migrations, (query) => {
    if (/^\s*DELETE FROM push_subscriptions/.test(query) && failNext) {
      failNext = false;
      throw new Error('D1_ERROR https://fcm.googleapis.com/fcm/send/secret');
    }
  });
  addSession(sqlite, 'host', 'h1');
  await subscribe(db, 'h1', 'first');
  await subscribe(db, 'h1', 'second');
  const send = dispatcher(db, () => 410);
  await send.run([notice('host')]);
  assert.equal(send.sent.length, 2);
  assert.equal(Object.keys(generations(sqlite)).length, 1);
  assert.ok(send.logs.includes('WEB_PUSH_CLEANUP_FAILED'));
  assert.ok(send.logs.every((line) => !line.includes('https://')));
});

void test('받는 사람이 없거나 구독이 없으면 키를 만들지 않고 아무것도 보내지 않는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'host', 'h1');
  const send = dispatcher(db, () => 201);
  await send.run([]);
  await send.run([notice('host')]);
  assert.deepEqual(send.sent, []);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS n FROM push_vapid_keys').get()!.n,
    0,
  );
});
