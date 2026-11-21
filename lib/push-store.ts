// D1 storage for Web Push (issue #14 T2): subscriptions and the VAPID key row,
// both created by drizzle/0002_push_subscriptions.sql. Only a minimal SQL
// interface is taken (D1 satisfies it) so this module never imports
// `cloudflare:workers`. initialize() in the API route must not reference these
// tables: a database without 0002 keeps working, and a deleted session takes
// its subscriptions with it through the foreign key cascade.

import type { PushSubscriptionRecord } from './push-subscription';
import type { StoredVapidKey, VapidKeyStore } from './vapid-keys';

export type SqlStatement = {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
};
export type SqlDatabase = { prepare(query: string): SqlStatement };

export function d1VapidKeyStore(db: SqlDatabase): VapidKeyStore {
  return {
    async read() {
      const row = await db
        .prepare(
          'SELECT public_key, private_jwk FROM push_vapid_keys WHERE id=1',
        )
        .first<{ public_key: string; private_jwk: string }>();
      return row
        ? { publicKey: row.public_key, privateJwk: row.private_jwk }
        : null;
    },
    async insertIfAbsent(key: StoredVapidKey) {
      // Concurrent first requests: one insert wins, the rest keep that row.
      await db
        .prepare(
          'INSERT INTO push_vapid_keys(id,public_key,private_jwk) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING',
        )
        .bind(key.publicKey, key.privateJwk)
        .run();
    },
  };
}

export type PushSaveResult = 'saved' | 'session-ended' | 'owned-elsewhere';

// The database clock in epoch milliseconds, the unit of sessions.expires
// (written from the Worker's Date.now()). Evaluated when the statement runs,
// so a session that expires while the write waits is no longer valid.
const databaseNow =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

// One statement decides and writes (R1·R2): the row is written only while the
// requesting session is still valid in the database, and an endpoint held by
// another account moves only when both p256dh and auth match. Every write gets
// a new generation so later cleanup can tell a rewritten row from the one it
// read.
export async function savePushSubscription(
  db: SqlDatabase,
  sessionHash: string,
  record: PushSubscriptionRecord,
  generation: string = crypto.randomUUID(),
): Promise<PushSaveResult> {
  const result = await db
    .prepare(
      `INSERT INTO push_subscriptions(endpoint,account_id,p256dh,auth,session,generation,created)
       SELECT ?, name, ?, ?, token, ?, ${databaseNow} FROM sessions WHERE token=? AND expires>${databaseNow}
       ON CONFLICT(endpoint) DO UPDATE SET
         account_id=excluded.account_id, p256dh=excluded.p256dh, auth=excluded.auth,
         session=excluded.session, generation=excluded.generation
       WHERE push_subscriptions.account_id=excluded.account_id
         OR (push_subscriptions.p256dh=excluded.p256dh AND push_subscriptions.auth=excluded.auth)`,
    )
    .bind(record.endpoint, record.p256dh, record.auth, generation, sessionHash)
    .run();
  if (result.meta.changes) return 'saved';
  // Nothing was written; this read only chooses the error status, on the same
  // database clock as the write.
  const session = await db
    .prepare(
      `SELECT 1 AS valid FROM sessions WHERE token=? AND expires>${databaseNow}`,
    )
    .bind(sessionHash)
    .first();
  return session ? 'owned-elsewhere' : 'session-ended';
}

// Removes the row only when it belongs to `account` (a moved row stays).
export async function removePushSubscription(
  db: SqlDatabase,
  account: string,
  endpoint: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND account_id=?')
    .bind(endpoint, account)
    .run();
  return result.meta.changes > 0;
}

// Delivery (issue #14 T3) also lists rows, which needs `all()`.
export type SqlListStatement = Omit<SqlStatement, 'bind'> & {
  bind(...values: unknown[]): SqlListStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};
export type SqlListDatabase = { prepare(query: string): SqlListStatement };

export type PushTarget = PushSubscriptionRecord & {
  account: string;
  generation: string;
};

// Delivery targets at send time: rows owned by one of `accounts` whose
// registering session still exists, belongs to that account and has not
// expired on the database clock (the same clock as the write above). A logged
// out session is gone (its rows cascade away); an expired one not yet swept by
// initialize() is excluded here.
export async function listPushTargets(
  db: SqlListDatabase,
  accounts: readonly string[],
): Promise<PushTarget[]> {
  if (!accounts.length) return [];
  const result = await db
    .prepare(
      `SELECT push_subscriptions.account_id AS account, endpoint, p256dh, auth, generation
       FROM push_subscriptions JOIN sessions ON sessions.token=push_subscriptions.session
       WHERE push_subscriptions.account_id IN (${accounts.map(() => '?').join(',')})
         AND sessions.name=push_subscriptions.account_id
         AND sessions.expires>${databaseNow}`,
    )
    .bind(...accounts)
    .all<PushTarget>();
  return result.results;
}

// A 404·410 removes only the row that was sent to: same endpoint and same
// generation. A row registered again, moved or rewritten meanwhile has a new
// generation and stays.
export async function removeGonePushSubscription(
  db: SqlDatabase,
  target: Pick<PushTarget, 'endpoint' | 'generation'>,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND generation=?')
    .bind(target.endpoint, target.generation)
    .run();
  return result.meta.changes > 0;
}
