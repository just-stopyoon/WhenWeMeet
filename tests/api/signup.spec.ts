import { randomUUID } from 'node:crypto';
import { test, expect, expectError } from '../support/fixtures';

test('가입과 로그인을 분리하고 중복 닉네임·동일 PIN 계정의 권한을 구분한다', async ({
  playwright,
  baseURL,
}) => {
  const first = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL! },
  });
  const second = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL! },
  });
  const id = `signup${randomUUID().slice(0, 8)}`;
  const signup = {
    type: 'signup',
    name: id,
    nickname: '같은 친구',
    pin: '0123',
  };
  try {
    await expectError(
      await first.post('/api/meeting', {
        data: { type: 'login', name: id, pin: '0123' },
      }),
      400,
      /아이디 또는 비밀번호/,
    );
    expect(await (await first.get('/api/meeting')).json()).toEqual({
      user: '',
      rooms: [],
    });
    const created = await first.post('/api/meeting', { data: signup });
    expect(created.status()).toBe(200);
    expect(await created.json()).toEqual({
      user: id,
      nickname: '같은 친구',
      rooms: [],
    });
    await expectError(
      await second.post('/api/meeting', { data: signup }),
      409,
      /이미 사용 중/,
    );
    expect(await (await second.get('/api/meeting')).json()).toEqual({
      user: '',
      rooms: [],
    });
    const other = await second.post('/api/meeting', {
      data: { ...signup, name: id + 'b' },
    });
    expect(other.status()).toBe(200);
    expect((await other.json()).nickname).toBe('같은 친구');
    const start = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const endDate = new Date(start + 'T12:00:00Z');
    endDate.setUTCDate(endDate.getUTCDate() + 6);
    const roomResponse = await first.post('/api/meeting', {
      data: {
        type: 'create',
        title: '중복 이름',
        start,
        end: endDate.toISOString().slice(0, 10),
        size: 2,
        mode: 'all',
      },
    });
    expect(roomResponse.status()).toBe(200);
    const { room } = await roomResponse.json();
    const joined = await second.post('/api/meeting', {
      data: { type: 'join', code: room.code },
    });
    const shared = (await joined.json()).room;
    expect(shared.members).toEqual([id, id + 'b']);
    expect(shared.memberNames).toEqual({
      [id]: '같은 친구',
      [id + 'b']: '같은 친구',
    });
    await expectError(
      await second.post('/api/meeting', {
        data: { type: 'close', roomId: room.id },
      }),
      400,
      /방장만/,
    );
    expect(
      (
        await first.post('/api/meeting', {
          data: { type: 'schedule', roomId: room.id, slots: [start + '|점심'] },
        })
      ).status(),
    ).toBe(200);
    const submitted = await second.post('/api/meeting', {
      data: { type: 'schedule', roomId: room.id, slots: [start + '|저녁'] },
    });
    expect((await submitted.json()).room.responses).toEqual({
      [id]: [start + '|점심'],
      [id + 'b']: [start + '|저녁'],
    });
    await first.post('/api/meeting', { data: { type: 'logout' } });
    const login = await first.post('/api/meeting', {
      data: { type: 'login', name: id, pin: '0123' },
    });
    expect(login.status()).toBe(200);
    expect((await login.json()).rooms[0].id).toBe(room.id);
    await first.post('/api/meeting', {
      data: { type: 'close', roomId: room.id },
    });
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test('동일 아이디 동시 가입은 한 번만 성공하고 잘못된 가입 입력은 거절한다', async ({
  playwright,
  baseURL,
}) => {
  const contexts = await Promise.all(
    [0, 1].map(() =>
      playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: baseURL! },
      }),
    ),
  );
  const signup = {
    type: 'signup',
    name: `race${randomUUID().slice(0, 8)}`,
    nickname: '친구',
    pin: '0000',
  };
  try {
    const responses = await Promise.all(
      contexts.map((context) => context.post('/api/meeting', { data: signup })),
    );
    expect(
      responses.map((response) => response.status()).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    for (const invalid of [
      { pin: '123' },
      { pin: '12345' },
      { pin: '12ab' },
      { pin: 1234 },
      { nickname: '' },
      { nickname: 'a'.repeat(21) },
      { name: '__proto__' },
      { name: ' ' },
    ]) {
      await expectError(
        await contexts[0].post('/api/meeting', {
          data: { ...signup, ...invalid },
        }),
        400,
      );
    }
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
  }
});
