import { env } from 'cloudflare:workers';
import { newRoom, daysBetween, type Room } from '../../../lib/meeting';
import {
  applyAction,
  expiresOn,
  koreanToday,
  type Action,
} from '../../../lib/room-actions';

const db = () => (env as unknown as { DB: D1Database }).DB;
async function initialize() {
  await db().batch([
    db().prepare(
      'CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)',
    ),
    db().prepare(
      'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL)',
    ),
    db().prepare(
      'CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, expires TEXT NOT NULL)',
    ),
    db().prepare(
      'CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)',
    ),
  ]);
  await db().batch([
    db().prepare('DELETE FROM rooms WHERE expires <= ?').bind(koreanToday()),
    db().prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()),
    db().prepare('DELETE FROM attempts WHERE expires < ?').bind(Date.now()),
  ]);
}
const reply = (data: unknown, status = 200, headers = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
async function digest(text: string) {
  return hex(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
}
async function pinHash(pin: string, salt: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode(salt),
        iterations: 100000,
        hash: 'SHA-256',
      },
      key,
      256,
    ),
  );
}
const cookieToken = (req: Request) =>
  req.headers.get('cookie')?.match(/(?:^|;\s*)wwm_session=([^;]+)/)?.[1] || '';
const cookie = (req: Request, value: string, age: number) =>
  `wwm_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
async function currentUser(req: Request) {
  return (
    await db()
      .prepare('SELECT name FROM sessions WHERE token = ? AND expires > ?')
      .bind(await digest(cookieToken(req)), Date.now())
      .first<{ name: string }>()
  )?.name;
}
async function limit(key: string, maximum: number) {
  const row = await db()
    .prepare(
      'INSERT INTO attempts(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
    )
    .bind(key, Date.now() + 15 * 60 * 1000)
    .first<{ count: number }>();
  if (row!.count > maximum)
    throw new Error('시도가 너무 많아요. 15분 후 다시 시도해 주세요.');
}
async function list(name: string) {
  const result = await db()
    .prepare(
      "SELECT data FROM rooms WHERE EXISTS (SELECT 1 FROM json_each(rooms.data, '$.members') WHERE value=?) AND expires > ?",
    )
    .bind(name, koreanToday())
    .all<{ data: string }>();
  return result.results.map((row) => JSON.parse(row.data) as Room);
}
export async function GET(req: Request) {
  try {
    await initialize();
    const user = await currentUser(req);
    return reply({ user: user || '', rooms: user ? await list(user) : [] });
  } catch {
    return reply(
      { error: '모임을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' },
      503,
    );
  }
}
export async function POST(req: Request) {
  try {
    if (req.headers.get('origin') !== new URL(req.url).origin)
      return reply({ error: '허용되지 않은 요청이에요.' }, 403);
    const raw = await req.text();
    if (raw.length > 20000) return reply({ error: '요청이 너무 커요.' }, 413);
    const a = JSON.parse(raw) as Action;
    await initialize();
    if (a.type === 'login') {
      const name =
        typeof a.name === 'string' ? a.name.normalize('NFC').trim() : '';
      if (
        !name ||
        name.length > 20 ||
        typeof a.pin !== 'string' ||
        !/^\d{4}$/.test(a.pin) ||
        Object.hasOwn(Object.prototype, name) ||
        name === 'prototype'
      )
        throw new Error('닉네임은 1~20자, PIN은 숫자 4자리로 입력해 주세요.');
      await limit(
        'login-ip:' +
          (await digest(req.headers.get('cf-connecting-ip') || 'local')),
        50,
      );
      await limit('login-name:' + name, 10);
      let account = await db()
        .prepare('SELECT salt, hash FROM accounts WHERE name=?')
        .bind(name)
        .first<{ salt: string; hash: string }>();
      if (!account) {
        const salt = crypto.randomUUID(),
          hash = await pinHash(a.pin, salt);
        await db()
          .prepare(
            'INSERT OR IGNORE INTO accounts(name,salt,hash) VALUES(?,?,?)',
          )
          .bind(name, salt, hash)
          .run();
        account = await db()
          .prepare('SELECT salt, hash FROM accounts WHERE name=?')
          .bind(name)
          .first<{ salt: string; hash: string }>();
      }
      if ((await pinHash(a.pin, account!.salt)) !== account!.hash)
        throw new Error('닉네임 또는 PIN을 확인해 주세요.');
      const token = crypto.randomUUID() + crypto.randomUUID();
      await db()
        .prepare('INSERT INTO sessions(token,name,expires) VALUES(?,?,?)')
        .bind(await digest(token), name, Date.now() + 30 * 86400000)
        .run();
      return reply({ user: name, rooms: await list(name) }, 200, {
        'Set-Cookie': cookie(req, token, 30 * 86400),
      });
    }
    const user = await currentUser(req);
    if (!user) return reply({ error: '다시 로그인해 주세요.' }, 401);
    if (a.type === 'logout') {
      await db()
        .prepare('DELETE FROM sessions WHERE token=?')
        .bind(await digest(cookieToken(req)))
        .run();
      return reply({}, 200, { 'Set-Cookie': cookie(req, '', 0) });
    }
    await limit('action:' + user, 300);
    if (a.type === 'create') {
      if (
        typeof a.title !== 'string' ||
        !a.title.trim() ||
        a.title.length > 60 ||
        typeof a.start !== 'string' ||
        typeof a.end !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(a.start) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(a.end) ||
        a.start < koreanToday() ||
        !Number.isInteger(a.size) ||
        Number(a.size) < 2 ||
        Number(a.size) > 10 ||
        !['all', 'most'].includes(a.mode as string)
      )
        throw new Error('모임 설정을 확인해 주세요.');
      const count = daysBetween(a.start, a.end).length;
      if (count < 7 || count > 31)
        throw new Error('기간은 7~31일로 선택해 주세요.');
      const r = newRoom(
        a.title.trim(),
        user,
        a.start,
        a.end,
        a.size as number,
        a.mode as 'all' | 'most',
        crypto.randomUUID(),
      );
      r.code = crypto
        .randomUUID()
        .replaceAll('-', '')
        .slice(0, 12)
        .toUpperCase();
      await db()
        .prepare('INSERT INTO rooms(id,code,data,expires) VALUES(?,?,?,?)')
        .bind(r.id, r.code, JSON.stringify(r), expiresOn(r))
        .run();
      return reply({ room: r });
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const row =
        a.type === 'join'
          ? await db()
              .prepare('SELECT id,data,version FROM rooms WHERE code=?')
              .bind(String(a.code).trim().toUpperCase())
              .first<{ id: string; data: string; version: number }>()
          : await db()
              .prepare('SELECT id,data,version FROM rooms WHERE id=?')
              .bind(String(a.roomId))
              .first<{ id: string; data: string; version: number }>();
      if (!row)
        throw new Error('모임을 찾을 수 없어요. 초대 코드를 확인해 주세요.');
      const updated = applyAction(JSON.parse(row.data), user, a);
      const result = await db()
        .prepare(
          'UPDATE rooms SET data=?,version=version+1,expires=? WHERE id=? AND version=?',
        )
        .bind(JSON.stringify(updated), expiresOn(updated), row.id, row.version)
        .run();
      if (result.meta.changes)
        return reply({ room: updated.members.includes(user) ? updated : null });
    }
    return reply(
      { error: '다른 친구가 제출 중이에요. 한 번 더 시도해 주세요.' },
      409,
    );
  } catch (error) {
    return reply(
      {
        error:
          error instanceof Error &&
          !/D1_|SQLITE|JSON|Unexpected/.test(error.message)
            ? error.message
            : '저장하지 못했어요. 다시 시도해 주세요.',
      },
      400,
    );
  }
}
