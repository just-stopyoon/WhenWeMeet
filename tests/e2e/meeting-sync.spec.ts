import { expect, test, type Page, type Route } from '@playwright/test';
import type { Room } from '../../lib/meeting';
import type {
  MeetingRequest,
  MeetingSnapshot,
} from '../../lib/meeting-contract';

// Explicit snapshots isolate client synchronization. Existing API/D1 tests
// verify persistence; no production reducer produces these mock responses.
const user = '방장';
const frozenTime = '2026-10-05T03:00:00.000Z';

function roomSnapshot(overrides: Partial<Room> = {}): Room {
  return {
    id: 'sync-room',
    code: 'SYNC00000001',
    title: '동기화 회귀 모임',
    start: '2026-10-05',
    end: '2026-10-18',
    size: 2,
    mode: 'all',
    host: user,
    members: [user, '친구'],
    responses: {
      [user]: ['2026-10-06|점심'],
      친구: ['2026-10-06|점심'],
    },
    stage: 'region',
    regions: ['연남', '문래'],
    votes: {},
    round: 1,
    regionRevision: 2,
    attendees: [user, '친구'],
    date: '2026-10-06|점심',
    confirmations: {},
    links: [],
    emails: {},
    ...overrides,
  };
}

async function pauseBeforeLoad(page: Page) {
  await page.clock.install({ time: new Date(Date.parse(frozenTime) - 1000) });
  await page.clock.pauseAt(new Date(frozenTime));
}

async function openRoom(page: Page, room: Room) {
  await page.goto('/');
  await page
    .getByRole('button')
    .filter({
      has: page.getByRole('heading', { name: room.title, exact: true }),
    })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function advanceToPoll(page: Page, milliseconds = 4000) {
  const received = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/meeting' &&
      response.request().method() === 'GET',
  );
  await page.clock.runFor(milliseconds);
  const response = await received;
  expect(response.status()).toBe(200);
  expect(await response.finished()).toBeNull();
}

async function submitAndWait(
  page: Page,
  submit: () => Promise<unknown>,
  payload: MeetingRequest,
  status: number,
) {
  const received = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/meeting' &&
      response.request().method() === 'POST',
  );
  await submit();
  const response = await received;
  expect(response.request().postDataJSON()).toEqual(payload);
  expect(response.status()).toBe(status);
  expect(await response.finished()).toBeNull();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}

test('입력 재렌더는 초기 GET을 반복하거나 4초 폴링 주기를 늦추지 않는다', async ({
  page,
}) => {
  const room = roomSnapshot();
  let gets = 0;
  const posts: unknown[] = [];
  await pauseBeforeLoad(page);
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 400,
        json: { error: '예상하지 않은 저장' },
      });
      return;
    }
    gets++;
    await route.fulfill({ json: { user, rooms: [room] } });
  });
  await openRoom(page, room);
  await page
    .getByRole('button', { name: '다른 지역 추가하기', exact: true })
    .click();
  const input = page
    .getByRole('dialog')
    .getByLabel('지역 이름', { exact: true });
  expect(gets).toBe(1);

  await page.clock.runFor(2000);
  await input.fill('작성 중');
  await expect(input).toHaveValue('작성 중');
  expect(gets).toBe(1);
  await page.clock.runFor(1999);
  await input.fill('작성 중인 지역');
  await expect(input).toHaveValue('작성 중인 지역');
  expect(gets).toBe(1);
  await advanceToPoll(page, 1);
  expect(gets).toBe(2);
  await expect(input).toHaveValue('작성 중인 지역');

  await page.clock.runFor(3999);
  await input.fill('입력은 계속 보존');
  expect(gets).toBe(2);
  await advanceToPoll(page, 1);
  expect(gets).toBe(3);
  await expect(input).toHaveValue('입력은 계속 보존');
  expect(posts).toEqual([]);
});

test('지연 POST 중에는 추가 POST와 폴링을 막고 실패 후 재시도와 폴링을 재개한다', async ({
  page,
}) => {
  const initial = roomSnapshot({
    stage: 'confirm',
    confirmations: { 친구: true },
    attendees: ['친구'],
  });
  const saved = roomSnapshot({
    confirmations: { [user]: true, 친구: true },
  });
  let current = initial;
  let gets = 0;
  const posts: unknown[] = [];
  const held: Route[] = [];
  await pauseBeforeLoad(page);
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'GET') {
      gets++;
      await route.fulfill({ json: { user, rooms: [current] } });
      return;
    }
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) held.push(route);
    else {
      current = saved;
      await route.fulfill({ json: { room: saved } });
    }
  });
  await openRoom(page, initial);
  const yes = page.getByRole('button', { name: '갈 수 있어요', exact: true });
  const no = page.getByRole('button', { name: '이번엔 어려워요', exact: true });
  const payload: MeetingRequest = {
    type: 'confirm',
    roomId: initial.id,
    value: true,
    regionRevision: 2,
  };
  await yes.click();
  await expect.poll(() => held.length).toBe(1);
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'true');
  await expect(no).toBeEnabled();
  // Reach the real event handler despite the saving overlay's pointer guard,
  // so this checks the hook's pending guard rather than CSS alone.
  await no.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement))
      throw new Error('Expected a button.');
    button.click();
    button.click();
  });
  await page.clock.runFor(8000);
  expect(posts).toEqual([payload]);
  expect(gets).toBe(1);
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'true');

  const failed = page.waitForResponse(
    (response) => response.request() === held[0].request(),
  );
  await held[0].fulfill({
    status: 400,
    json: { error: '잠시 후 다시 제출해 주세요.' },
  });
  expect(await (await failed).finished()).toBeNull();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByRole('status')).toHaveText(
    '잠시 후 다시 제출해 주세요.',
  );
  await expect(
    page.getByRole('heading', { name: '이날, 함께할 수 있나요?' }),
  ).toBeVisible();
  await expect(yes).toHaveAttribute('aria-pressed', 'false');

  await submitAndWait(page, () => yes.click(), payload, 200);
  expect(posts).toEqual([payload, payload]);
  await expect(
    page.getByRole('heading', { name: '어디에서 만날까요?' }),
  ).toBeVisible();
  await advanceToPoll(page);
  expect(gets).toBe(2);
  await expect(
    page.getByRole('heading', { name: '어디에서 만날까요?' }),
  ).toBeVisible();
});

test('로그인과 로그아웃 실패는 기존 세션을 유지하고 성공한 재시도에만 세션을 교체한다', async ({
  page,
}) => {
  const room = roomSnapshot();
  let snapshot: MeetingSnapshot = { user: '', rooms: [] };
  let gets = 0;
  const posts: unknown[] = [];
  const login: MeetingRequest = { type: 'login', name: user, pin: '1234' };
  const logout: MeetingRequest = { type: 'logout' };
  await pauseBeforeLoad(page);
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'GET') {
      gets++;
      await route.fulfill({ json: snapshot });
      return;
    }
    posts.push(route.request().postDataJSON());
    if (posts.length === 1)
      await route.fulfill({
        status: 400,
        json: { error: '로그인을 다시 시도해 주세요.' },
      });
    else if (posts.length === 2) {
      snapshot = { user, rooms: [room] };
      await route.fulfill({ json: snapshot });
    } else if (posts.length === 3)
      await route.fulfill({
        status: 400,
        json: { error: '로그아웃을 다시 시도해 주세요.' },
      });
    else if (posts.length === 4) {
      snapshot = { user: '', rooms: [] };
      await route.fulfill({ json: {} });
    } else
      await route.fulfill({
        status: 400,
        json: { error: '예상하지 않은 저장' },
      });
  });
  await page.goto('/');
  const nickname = page.getByLabel('닉네임', { exact: true });
  const pin = page.getByLabel('숫자 4자리 PIN', { exact: true });
  const start = page.getByRole('button', { name: '시작하기', exact: true });
  await nickname.fill(user);
  await pin.fill('1234');
  await submitAndWait(page, () => start.click(), login, 400);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '어떻게 불러드릴까요?',
  );
  await expect(nickname).toHaveValue(user);
  await expect(pin).toHaveValue('1234');
  await page.clock.runFor(8000);
  expect(gets).toBe(1);

  await submitAndWait(page, () => start.click(), login, 200);
  const roomCard = page.getByRole('button').filter({
    has: page.getByRole('heading', { name: room.title, exact: true }),
  });
  await expect(roomCard).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    `${user}님`,
  );
  await advanceToPoll(page);
  expect(gets).toBe(2);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '내 계정', exact: true });
  const signOut = dialog.getByRole('button', {
    name: '다른 닉네임으로 들어가기',
    exact: true,
  });
  await submitAndWait(page, () => signOut.click(), logout, 400);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${user}님으로 이용 중이에요.`);
  await expect(dialog.getByRole('alert')).toHaveText(
    '로그아웃을 다시 시도해 주세요.',
  );
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(roomCard).toBeVisible();
  await advanceToPoll(page);
  expect(gets).toBe(3);

  await page.getByRole('button', { name: '설정', exact: true }).click();
  await submitAndWait(page, () => signOut.click(), logout, 200);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '어떻게 불러드릴까요?',
  );
  await expect(roomCard).toHaveCount(0);
  await expect(pin).toHaveValue('');
  await page.clock.runFor(8000);
  expect(gets).toBe(3);
  expect(posts).toEqual([login, login, logout, logout]);
});

test('인증된 초대 진입은 초기 GET 시작 시 캡처한 코드를 응답 이후에도 사용한다', async ({
  page,
}) => {
  const held: Route[] = [];
  const posts: unknown[] = [];
  await pauseBeforeLoad(page);
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'GET') held.push(route);
    else {
      posts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 400,
        json: { error: '예상하지 않은 저장' },
      });
    }
  });
  await page.goto('/?join=abc123def456');
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => {
    window.history.replaceState(null, '', '/?join=changed00000');
  });
  const received = page.waitForResponse(
    (response) => response.request() === held[0].request(),
  );
  await held[0].fulfill({ json: { user, rooms: [] } });
  expect(await (await received).finished()).toBeNull();

  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '초대 코드를 입력해요',
  );
  await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
    'ABC123DEF456',
  );
  await expect(
    page.getByRole('button', { name: '모임 참가하기', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('닉네임', { exact: true })).toHaveCount(0);
  expect(held).toHaveLength(1);
  expect(posts).toEqual([]);
});
