import {
  test,
  expect,
  action,
  addDays,
  createRoom,
  expectError,
  listRooms,
  postAction,
  today,
} from '../support/fixtures';

test('로그인, 재접속, 로그아웃은 독립 세션에 반영된다', async ({
  accounts,
  playwright,
  baseURL,
}) => {
  const [host] = accounts;
  const room = await createRoom(host);
  const request = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL! },
  });
  try {
    const anonymous = await request.get('/api/meeting');
    expect(await anonymous.json()).toEqual({ user: '', rooms: [] });
    await expectError(
      await request.post('/api/meeting', { data: { type: 'create' } }),
      401,
    );
    await expectError(
      await request.post('/api/meeting', {
        data: {
          type: 'login',
          name: host.name,
          pin: host.pin === '0000' ? '0001' : '0000',
        },
      }),
      400,
      /닉네임 또는 PIN/,
    );
    const login = await request.post('/api/meeting', {
      data: { type: 'login', name: host.name, pin: host.pin },
    });
    expect(login.status()).toBe(200);
    const cookie = login.headers()['set-cookie'] ?? '';
    expect(cookie.includes('HttpOnly')).toBe(true);
    expect(cookie.includes('SameSite=Lax')).toBe(true);
    const state = await request.storageState();
    const reconnected = await playwright.request.newContext({
      baseURL,
      storageState: state,
      extraHTTPHeaders: { Origin: baseURL! },
    });
    try {
      const loaded = await reconnected.get('/api/meeting');
      const body = await loaded.json();
      expect(body.user).toBe(host.name);
      expect(
        body.rooms.some((entry: { id: string }) => entry.id === room.id),
      ).toBe(true);
      expect(
        (
          await request.post('/api/meeting', { data: { type: 'logout' } })
        ).status(),
      ).toBe(200);
      expect(await (await reconnected.get('/api/meeting')).json()).toEqual({
        user: '',
        rooms: [],
      });
      await expectError(
        await reconnected.post('/api/meeting', { data: { type: 'create' } }),
        401,
      );
    } finally {
      await reconnected.dispose();
    }
    expect((await listRooms(host)).some((entry) => entry.id === room.id)).toBe(
      true,
    );
  } finally {
    await request.dispose();
    await action(host, { type: 'close', roomId: room.id });
  }
});

test('동일 출처, 요청 크기, 생성 입력 검증을 유지한다', async ({
  accounts,
}) => {
  const [host] = accounts;
  await expectError(
    await host.request.post('/api/meeting', {
      headers: { Origin: 'http://untrusted.invalid' },
      data: { type: 'logout' },
    }),
    403,
  );
  await expectError(
    await host.request.post('/api/meeting', { data: 'x'.repeat(20001) }),
    413,
  );
  const start = today();
  for (const invalid of [
    { size: 1 },
    { size: 11 },
    { end: addDays(start, 5) },
    { end: addDays(start, 31) },
    { title: '' },
    { mode: 'unknown' },
  ])
    await expectError(
      await postAction(host, {
        type: 'create',
        title: '잘못된 입력',
        start,
        end: addDays(start, 13),
        size: 3,
        mode: 'all',
        ...invalid,
      }),
      400,
    );
  await listRooms(host);
});

test('참가 전 방 목록과 변경 권한은 계정별로 격리된다', async ({
  accounts,
}) => {
  const [host, friend, outsider] = accounts;
  const room = await createRoom(host, { size: 2 });
  expect((await listRooms(friend)).some((entry) => entry.id === room.id)).toBe(
    false,
  );
  await expectError(
    await postAction(outsider, {
      type: 'schedule',
      roomId: room.id,
      slots: [],
    }),
    400,
    /참여자가 아니/,
  );
  await action(friend, { type: 'join', code: room.code.toLowerCase() });
  expect((await listRooms(friend)).some((entry) => entry.id === room.id)).toBe(
    true,
  );
  await expectError(
    await postAction(outsider, { type: 'join', code: room.code }),
    400,
    /정원이 찼거나/,
  );
  await expectError(
    await postAction(friend, { type: 'close', roomId: room.id }),
    400,
    /방장만/,
  );
  await action(host, { type: 'close', roomId: room.id });
});
