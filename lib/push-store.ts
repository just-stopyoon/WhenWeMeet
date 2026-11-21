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

// One statement decides and writes (R1·R2): the row is written only while the
// requesting session is still valid, and an endpoint held by another account
// moves only when both p256dh and auth match. Every write gets a new
// generation so later cleanup can tell a rewritten row from the one it read.
export async function savePushSubscription(
  db: SqlDatabase,
  sessionHash: string,
  record: PushSubscriptionRecord,
  now = Date.now(),
  generation: string = crypto.randomUUID(),
): Promise<PushSaveResult> {
  const result = await db
    .prepare(
      `INSERT INTO push_subscriptions(endpoint,account_id,p256dh,auth,session,generation,created)
       SELECT ?, name, ?, ?, token, ?, ? FROM sessions WHERE token=? AND expires>?
       ON CONFLICT(endpoint) DO UPDATE SET
         account_id=excluded.account_id, p256dh=excluded.p256dh, auth=excluded.auth,
         session=excluded.session, generation=excluded.generation
       WHERE push_subscriptions.account_id=excluded.account_id
         OR (push_subscriptions.p256dh=excluded.p256dh AND push_subscriptions.auth=excluded.auth)`,
    )
    .bind(
      record.endpoint,
      record.p256dh,
      record.auth,
      generation,
      now,
      sessionHash,
      now,
    )
    .run();
  if (result.meta.changes) return 'saved';
  // Nothing was written; this read only chooses the error status.
  const session = await db
    .prepare('SELECT 1 AS valid FROM sessions WHERE token=? AND expires>?')
    .bind(sessionHash, now)
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
