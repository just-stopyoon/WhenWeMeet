import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  getRoom,
  postAction,
  test,
  uniqueTitle,
  type Room,
} from '../support/fixtures';

// /?room= entry from a notification click (issue #14 T4, decision S3). Real
// API/D1 only: the member check is the server's room list.
const goneToast = '종료되었거나 더 이상 참여 중인 모임이 아니에요.';

async function expectRoomOpened(page: Page, room: Room) {
  await expect(page.locator('header b')).toHaveText(room.title);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
}

async function expectHomeWithToast(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '우리 언제 만날까요?',
  );
  await expect(page.locator('.toast')).toHaveText(goneToast);
  await expect(page).toHaveURL(/\/$/);
}

test('/?room= 진입은 내 모임이면 그 모임을 열고 URL을 정리한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('알림 진입 멤버') });
    await context.addCookies(host.storageState.cookies);
    await page.goto(`/?room=${room.id}`);
    await expectRoomOpened(page, room);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('/?room= 진입은 나간·종료된·없는 모임이면 홈과 기존 토스트를 보인다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let left: Room | undefined;
  let closed: Room | undefined;
  try {
    left = await createRoom(host, { title: uniqueTitle('알림 진입 나감') });
    await action(guest, { type: 'join', code: left.code });
    const leave = await postAction(guest, {
      type: 'remove',
      roomId: left.id,
      member: guest.name,
    });
    expect(leave.status()).toBe(200);
    closed = await createRoom(host, { title: uniqueTitle('알림 진입 종료') });
    await action(guest, { type: 'join', code: closed.code });
    await action(host, { type: 'close', roomId: closed.id });
    expect((await getRoom(host, left.id)).members).toEqual([host.name]);

    await context.addCookies(guest.storageState.cookies);
    for (const id of [left.id, closed.id, `missing-${randomUUID()}`]) {
      await page.goto(`/?room=${encodeURIComponent(id)}`);
      await expectHomeWithToast(page);
      await expect(page.locator('header b')).toHaveText('언제 만날래');
    }
  } finally {
    if (left) await action(host, { type: 'close', roomId: left.id });
  }
});

test('로그인 전 /?room= 진입은 첫 조회 실패·재시도 동안 보관했다가 로그인 뒤 그 모임을 연다', async ({
  page,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  let initialFailed = false;
  try {
    room = await createRoom(host, { title: uniqueTitle('알림 진입 로그인') });
    await page.route('**/api/meeting', async (route) => {
      if (route.request().method() === 'GET' && !initialFailed) {
        initialFailed = true;
        await route.fulfill({ status: 503, json: { error: '첫 조회만 실패' } });
      } else await route.continue();
    });
    await page.goto(`/?room=${room.id}`);
    await page
      .getByRole('button', { name: '다시 연결하기', exact: true })
      .click();
    await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('room')).toBe(room.id);
    await page.getByLabel('아이디', { exact: true }).fill(host.name);
    await page
      .getByLabel('숫자 4자리 비밀번호', { exact: true })
      .fill(host.pin);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expectRoomOpened(page, room);
    expect(initialFailed).toBe(true);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('로그인 전 /?room= 진입 뒤 그 모임에 없는 계정으로 회원가입하면 홈과 토스트를 보인다', async ({
  page,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('알림 진입 가입') });
    await page.goto(`/?room=${room.id}`);
    await page.getByRole('button', { name: '처음이에요 · 회원가입' }).click();
    await page
      .getByPlaceholder('친구들이 알아볼 수 있는 이름')
      .fill('알림 진입');
    await page
      .getByLabel('아이디', { exact: true })
      .fill(`entry${randomUUID().replaceAll('-', '').slice(0, 10)}`);
    await page.getByLabel('숫자 4자리 비밀번호', { exact: true }).fill('0123');
    await page.getByRole('button', { name: '회원가입', exact: true }).click();
    await expectHomeWithToast(page);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('/?join=과 /?room=이 함께 있으면 참가 화면이 우선이다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let invited: Room | undefined;
  let member: Room | undefined;
  try {
    invited = await createRoom(host, { title: uniqueTitle('알림 진입 초대') });
    member = await createRoom(guest, { title: uniqueTitle('알림 진입 내 방') });
    await context.addCookies(guest.storageState.cookies);
    await page.goto(`/?join=${invited.code}&room=${member.id}`);
    await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
      invited.code,
    );
    await expect(page.locator('header b')).toHaveText('모임 참가');
    await expect(page.locator('.toast')).toHaveCount(0);
  } finally {
    if (invited) await action(host, { type: 'close', roomId: invited.id });
    if (member) await action(guest, { type: 'close', roomId: member.id });
  }
});

// No kept entry: a join code left in the form still leads to the join screen
// after signing in again, as before T4. The test server allows 50 sign-in or
// sign-up attempts per IP in 15 minutes (and 10 per account name); this test
// uses two.
test('보관한 진입 없이 다시 로그인하면 폼에 남은 참가 코드로 참가 화면을 이어 간다', async ({
  page,
  context,
  baseURL,
  accounts,
}) => {
  const [, guest] = accounts;
  // A separate session, so logging out keeps the shared fixture session.
  const login = await context.request.post('/api/meeting', {
    headers: { Origin: new URL(baseURL!).origin },
    data: { type: 'login', name: guest.name, pin: guest.pin },
  });
  expect(login.status()).toBe(200);
  await page.goto('/');
  await page.getByRole('button', { name: '코드로 참가' }).click();
  await page.getByLabel('초대 코드', { exact: true }).fill('OLDCODE00000');
  await page.getByRole('button', { name: '내 모임으로', exact: true }).click();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '로그아웃' })
    .click();
  await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
  await page.getByLabel('아이디', { exact: true }).fill(guest.name);
  await page.getByLabel('숫자 4자리 비밀번호', { exact: true }).fill(guest.pin);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.locator('header b')).toHaveText('모임 참가');
  await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
    'OLDCODE00000',
  );
});

// An empty join key still means "join and room together": room is dropped
// (S3, issue #14 T4 final review).
test('/?join=(빈 값)과 /?room=이 함께 있으면 room을 버리고 모임을 열지 않는다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('빈 초대 키 진입') });
    await context.addCookies(host.storageState.cookies);
    await page.goto(`/?join=&room=${room.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '우리 언제 만날까요?',
    );
    await expect(
      page.getByRole('heading', { name: room.title, exact: true }),
    ).toBeVisible();
    await expect(page.locator('header b')).toHaveText('언제 만날래');
    await expect(page.locator('.toast')).toHaveCount(0);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

// A room the home list can show but the room screen cannot open (votes
// missing) is not opened by the entry: home and the existing toast instead
// (issue #14 T4 final review). Mocked list: the server never sends this.
test('/?room= 대상 모임이 방 화면에서 읽는 필드가 없으면 열지 않고 홈과 기존 토스트를 보인다', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const damaged = {
    id: 'damaged-room',
    code: 'DAMAGED00000',
    title: '필드가 빠진 모임',
    stage: 'schedule',
    host: 'entry-user',
    members: ['entry-user'],
    responses: {},
    start: '2099-01-01',
    end: '2099-01-20',
    size: 2,
    mode: 'all',
    regions: [],
    round: 1,
    attendees: [],
    links: [],
    emails: {},
  };
  await page.route('**/api/meeting', (route) =>
    route.fulfill({
      json: { user: 'entry-user', nickname: '진입', rooms: [damaged] },
    }),
  );
  await page.goto('/?room=damaged-room');
  await expect(page.locator('.toast')).toHaveText(goneToast);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '우리 언제 만날까요?',
  );
  await expect(
    page.getByRole('heading', { name: damaged.title, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(errors).toEqual([]);
});

// Stage-specific fields and nested types the room screen reads (issue #14
// final review, Spec 4). Each broken target goes home with the toast; the
// complete final room still opens. Mocked list: the server never sends these.
const finalRoom = {
  id: 'entry-final',
  code: 'FINAL0000000',
  title: '단계별 필드 모임',
  stage: 'final',
  host: 'entry-user',
  members: ['entry-user', 'friend'],
  responses: {},
  start: '2099-01-01',
  end: '2099-01-20',
  size: 2,
  mode: 'all',
  regions: ['연남'],
  votes: { 'entry-user': ['연남'] },
  round: 1,
  attendees: ['entry-user', 'friend'],
  date: '2099-01-05|저녁',
  region: '연남',
  links: [
    {
      id: 'l1',
      url: 'https://example.com/a',
      name: '가게',
      category: 'food',
      author: 'entry-user',
    },
  ],
  emails: {},
};
const { links: _links, ...finalWithoutLinks } = finalRoom;
const { date: _date, ...finalWithoutDate } = finalRoom;
for (const [name, room] of [
  ['확정 단계에 links가 없음', finalWithoutLinks],
  ['확정 단계에 date가 없음', finalWithoutDate],
  [
    '지역 투표 단계의 votes 값이 숫자',
    { ...finalRoom, stage: 'region', region: undefined, votes: { friend: 3 } },
  ],
  // Saved links are absolute http(s) URLs; the cards parse them.
  [
    '확정 단계 링크가 상대 주소',
    { ...finalRoom, links: [{ ...finalRoom.links[0], url: '/a' }] },
  ],
  [
    '확정 단계 링크가 빈 문자열',
    { ...finalRoom, links: [{ ...finalRoom.links[0], url: '' }] },
  ],
  [
    '확정 단계 링크가 http(s)가 아님',
    {
      ...finalRoom,
      links: [{ ...finalRoom.links[0], url: 'javascript:alert(1)' }],
    },
  ],
  // The slot's shape is right but the day does not exist.
  ['확정 단계 날짜가 달력에 없음', { ...finalRoom, date: '2099-99-99|저녁' }],
  ['확정 단계 날짜가 2월 30일', { ...finalRoom, date: '2099-02-30|점심' }],
] as const) {
  test(`/?room= 대상 모임이 단계별 필수값을 갖추지 못하면(${name}) 열지 않고 홈과 기존 토스트를 보인다`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/meeting', (route) =>
      route.fulfill({
        json: { user: 'entry-user', nickname: '진입', rooms: [room] },
      }),
    );
    await page.goto(`/?room=${finalRoom.id}`);
    await expect(page.locator('.toast')).toHaveText(goneToast);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '우리 언제 만날까요?',
    );
    await expect(page).toHaveURL(/\/$/);
    expect(errors).toEqual([]);
  });
}

test('/?room= 대상 모임이 단계별 필수값을 갖추면 확정 단계도 연다', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/meeting', (route) =>
    route.fulfill({
      json: { user: 'entry-user', nickname: '진입', rooms: [finalRoom] },
    }),
  );
  await page.goto(`/?room=${finalRoom.id}`);
  await expect(page.locator('header b')).toHaveText(finalRoom.title);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(errors).toEqual([]);
});
