import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  d1VapidKeyStore,
  removePushSubscription,
  savePushSubscription,
  type SqlDatabase,
  type SqlStatement,
} from '../lib/push-store';
import { loadPushPublicKey, withPushPublicKey } from '../lib/vapid-keys';

// Issue #14 T2: the SQL in lib/push-store.ts run on SQLite (D1's engine) with
// foreign keys on and the real migration files applied. This stand-in is
// test-only; it does not reproduce D1 batches, transactions or concurrency
// across isolates, which the HTTP tests and the one-off probe cover.

const migrations = [
  '0000_shared_rooms.sql',
  '0001_account_profiles.sql',
  '0002_push_subscriptions.sql',
];

function database(files = migrations) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of files)
    sqlite.exec(readFileSync(join(process.cwd(), 'drizzle', file), 'utf8'));
  const statement = (query: string, values: unknown[] = []): SqlStatement => ({
    bind: (...next: unknown[]) => statement(query, next),
    first: <T>() =>
      Promise.resolve(
        (sqlite.prepare(query).get(...(values as never[])) ?? null) as T | null,
      ),
    run: () =>
      Promise.resolve({
        meta: {
          changes: Number(
            sqlite.prepare(query).run(...(values as never[])).changes,
          ),
        },
      }),
  });
  const db: SqlDatabase = { prepare: (query) => statement(query) };
  return { sqlite, db };
}

const now = 1_800_000_000_000;
const later = now + 86_400_000;

function addSession(
  sqlite: DatabaseSync,
  account: string,
  token: string,
  expires = later,
) {
  sqlite
    .prepare('INSERT OR IGNORE INTO accounts(name,salt,hash) VALUES(?,?,?)')
    .run(account, 's', 'h');
  sqlite
    .prepare('INSERT INTO sessions(token,name,expires) VALUES(?,?,?)')
    .run(token, account, expires);
}

type Row = {
  endpoint: string;
  account_id: string;
  p256dh: string;
  auth: string;
  session: string;
  generation: string;
};
const rows = (sqlite: DatabaseSync) =>
  sqlite
    .prepare(
      'SELECT endpoint, account_id, p256dh, auth, session, generation FROM push_subscriptions ORDER BY endpoint',
    )
    .all()
    .map((row) => ({ ...row })) as Row[];

const record = (suffix = '1', p256dh = 'p256dh-a', auth = 'auth-a') => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
  p256dh,
  auth,
});

void test('유효한 세션의 등록은 계정·세션·세대와 함께 저장된다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'alice', 'hash-a1');
  assert.equal(
    await savePushSubscription(db, 'hash-a1', record(), now, 'g1'),
    'saved',
  );
  assert.deepEqual(rows(sqlite), [
    {
      endpoint: record().endpoint,
      account_id: 'alice',
      p256dh: 'p256dh-a',
      auth: 'auth-a',
      session: 'hash-a1',
      generation: 'g1',
    },
  ]);
});

void test('logout으로 지워진 세션의 늦은 등록은 행을 만들지 않는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'alice', 'hash-a1');
  sqlite.prepare('DELETE FROM sessions WHERE token=?').run('hash-a1');
  assert.equal(
    await savePushSubscription(db, 'hash-a1', record(), now, 'g1'),
    'session-ended',
  );
  assert.deepEqual(rows(sqlite), []);
});

void test('만료된 세션의 등록은 행을 만들지 않는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'alice', 'hash-a1', now);
  assert.equal(
    await savePushSubscription(db, 'hash-a1', record(), now, 'g1'),
    'session-ended',
  );
  assert.deepEqual(rows(sqlite), []);
});

void test('다른 계정은 p256dh·auth가 둘 다 같을 때만 옮겨 간다', async () => {
  for (const [label, p256dh, auth, moved] of [
    ['p256dh만 다름', 'p256dh-b', 'auth-a', false],
    ['auth만 다름', 'p256dh-a', 'auth-b', false],
    ['둘 다 다름', 'p256dh-b', 'auth-b', false],
    ['둘 다 같음', 'p256dh-a', 'auth-a', true],
  ] as const) {
    const { sqlite, db } = database();
    addSession(sqlite, 'alice', 'hash-a1');
    addSession(sqlite, 'bob', 'hash-b1');
    await savePushSubscription(db, 'hash-a1', record(), now, 'g1');
    assert.equal(
      await savePushSubscription(
        db,
        'hash-b1',
        record('1', p256dh, auth),
        now,
        'g2',
      ),
      moved ? 'saved' : 'owned-elsewhere',
      label,
    );
    assert.deepEqual(
      rows(sqlite),
      [
        moved
          ? {
              endpoint: record().endpoint,
              account_id: 'bob',
              p256dh,
              auth,
              session: 'hash-b1',
              generation: 'g2',
            }
          : {
              endpoint: record().endpoint,
              account_id: 'alice',
              p256dh: 'p256dh-a',
              auth: 'auth-a',
              session: 'hash-a1',
              generation: 'g1',
            },
      ],
      label,
    );
  }
});

void test('같은 계정의 다시 등록은 키·세션을 바꾸고 새 세대를 받는다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'alice', 'hash-a1');
  addSession(sqlite, 'alice', 'hash-a2');
  await savePushSubscription(db, 'hash-a1', record(), now, 'g1');
  assert.equal(
    await savePushSubscription(db, 'hash-a1', record(), now, 'g2'),
    'saved',
  );
  assert.equal(rows(sqlite)[0].generation, 'g2');
  assert.equal(
    await savePushSubscription(
      db,
      'hash-a2',
      record('1', 'p256dh-c', 'auth-c'),
      now,
      'g3',
    ),
    'saved',
  );
  assert.deepEqual(rows(sqlite), [
    {
      endpoint: record().endpoint,
      account_id: 'alice',
      p256dh: 'p256dh-c',
      auth: 'auth-c',
      session: 'hash-a2',
      generation: 'g3',
    },
  ]);
});

void test('평소 세대 값은 쓸 때마다 새로 만든다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'alice', 'hash-a1');
  await savePushSubscription(db, 'hash-a1', record(), now);
  const first = rows(sqlite)[0].generation;
  await savePushSubscription(db, 'hash-a1', record(), now);
  const second = rows(sqlite)[0].generation;
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

void test('세션 행이 지워지면 그 세션의 구독만 연쇄 삭제된다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'alice', 'hash-a1');
  addSession(sqlite, 'alice', 'hash-a2');
  await savePushSubscription(db, 'hash-a1', record('1'), now, 'g1');
  await savePushSubscription(
    db,
    'hash-a2',
    record('2', 'p256dh-b', 'auth-b'),
    now,
    'g2',
  );
  // The same statements logout and the expired-session cleanup run.
  sqlite.prepare('DELETE FROM sessions WHERE token=?').run('hash-a1');
  assert.deepEqual(
    rows(sqlite).map((row) => row.session),
    ['hash-a2'],
  );
  sqlite
    .prepare('UPDATE sessions SET expires=? WHERE token=?')
    .run(now - 1, 'hash-a2');
  sqlite.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  assert.deepEqual(rows(sqlite), []);
});

void test('해지는 지금 계정의 행만 지운다', async () => {
  const { sqlite, db } = database();
  addSession(sqlite, 'alice', 'hash-a1');
  addSession(sqlite, 'bob', 'hash-b1');
  await savePushSubscription(db, 'hash-a1', record(), now, 'g1');
  assert.equal(
    await removePushSubscription(db, 'bob', record().endpoint),
    false,
  );
  assert.equal(rows(sqlite).length, 1);
  assert.equal(
    await removePushSubscription(db, 'alice', record().endpoint),
    true,
  );
  assert.deepEqual(rows(sqlite), []);
  assert.equal(
    await removePushSubscription(db, 'alice', record().endpoint),
    false,
  );
});

void test('D1 키 저장소는 비어 있을 때 동시 첫 요청에도 키 행 하나만 남긴다', async () => {
  const { sqlite, db } = database();
  const store = d1VapidKeyStore(db);
  const [first, second] = await Promise.all([
    loadPushPublicKey(store),
    loadPushPublicKey(store),
  ]);
  assert.equal(first, second);
  assert.equal(await loadPushPublicKey(d1VapidKeyStore(db)), first);
  const keys = sqlite
    .prepare('SELECT id, public_key FROM push_vapid_keys')
    .all()
    .map((row) => ({ ...row })) as { id: number; public_key: string }[];
  assert.deepEqual(keys, [{ id: 1, public_key: first }]);
});

void test('0002가 없는 DB에서는 응답이 키만 빠지고 나머지는 그대로다', async () => {
  const { db } = database(migrations.slice(0, 2));
  const lines: string[] = [];
  const body = { user: 'alice', nickname: '앨리스', rooms: [] };
  const result = await withPushPublicKey(body, d1VapidKeyStore(db), (line) =>
    lines.push(line),
  );
  assert.deepEqual(result, body);
  assert.deepEqual(lines, ['WEB_PUSH_KEY_UNAVAILABLE']);
});
