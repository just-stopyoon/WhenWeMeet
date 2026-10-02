import { expect, test, type Page, type Route } from '@playwright/test';
import type { Room } from '../../lib/meeting';

// These are UI-only snapshots. Server transitions and D1 are tested separately;
// the mock deliberately does not call applyAction or other production reducers.
const dates = [
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
  '2026-10-09',
  '2026-10-10',
  '2026-10-11',
  '2026-10-12',
];
const slots = dates.flatMap((date) => [date + '|점심', date + '|저녁']);
const beforeMidnight = '2026-10-02T14:59:58.000Z';
const afterMidnight = '2026-10-02T15:00:00.000Z';

function roomSnapshot(overrides: Partial<Room> = {}): Room {
  return {
    id: 'timing-room',
    code: 'TIMING000001',
    title: '시간 경계 확인 모임',
    start: '2026-10-02',
    end: '2026-10-12',
    size: 2,
    mode: 'all',
    host: '방장',
    members: ['방장', '친구'],
    responses: { 방장: [...slots], 친구: [...slots] },
    stage: 'date',
    regions: ['A', 'B'],
    votes: {},
    round: 1,
    regionRevision: 3,
    attendees: [],
    links: [],
    emails: {},
    ...overrides,
  };
}

async function freezeBeforeLoad(page: Page, time = beforeMidnight) {
  // Install before navigation so initialization and the hook use the same date.
  // Pause one second after installation, before any application timers exist.
  await page.clock.install({ time: new Date(Date.parse(time) - 1000) });
  await page.clock.pauseAt(new Date(time));
}

async function mockReadOnlyRoom(page: Page, room: Room) {
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({
        status: 400,
        json: { error: '이 화면 검증에서는 저장 요청을 예상하지 않습니다.' },
      });
      return;
    }
    await route.fulfill({ json: { user: '방장', rooms: [room] } });
  });
}

async function openRoom(page: Page, room: Room) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(room.title) }).click();
}

test('한국 자정에 지난 후보를 숨기고 더보기를 접으며 수동 날짜 제한을 갱신한다', async ({
  page,
}) => {
  const room = roomSnapshot();
  await freezeBeforeLoad(page);
  await mockReadOnlyRoom(page, room);
  await openRoom(page, room);

  const candidates = page.locator('.date-candidate');
  const dateInput = page.getByLabel('다른 날짜', { exact: true });
  await expect(candidates).toHaveCount(7);
  await expect(candidates.locator('.date-square b')).toHaveText([
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
  ]);
  await expect(dateInput).toHaveAttribute('min', '2026-10-02');
  await dateInput.fill('2026-10-02');
  await expect(
    page.getByRole('button', { name: '점심으로 다시 확인' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '날짜 더 보기' }).click();
  await expect(candidates).toHaveCount(11);

  await page.clock.runFor(2000);

  await expect(dateInput).toHaveAttribute('min', '2026-10-03');
  await expect(dateInput).toHaveValue('2026-10-02');
  await expect(
    page.getByRole('button', { name: '점심으로 다시 확인' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '저녁으로 다시 확인' }),
  ).toBeDisabled();
  await expect(candidates).toHaveCount(7);
  await expect(candidates.locator('.date-square b')).toHaveText([
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
  ]);
  await expect(
    page.getByRole('button', { name: '날짜 더 보기' }),
  ).toBeVisible();
});

test('한국 자정에 선택 중인 과거 슬롯을 막고 작성 중인 전체 응답을 보존한다', async ({
  page,
}) => {
  const room = roomSnapshot({
    stage: 'schedule',
    responses: { 친구: [...slots] },
  });
  await freezeBeforeLoad(page);
  await mockReadOnlyRoom(page, room);
  await openRoom(page, room);

  const lunch = page.getByRole('button', { name: '점심', exact: true });
  const dinner = page.getByRole('button', { name: '저녁', exact: true });
  const today = page.getByRole('button', {
    name: '10월 2일 (금) 선택',
    exact: true,
  });
  const tomorrow = page.getByRole('button', {
    name: '10월 3일 (토) 선택',
    exact: true,
  });
  await lunch.click();
  await tomorrow.click();
  await dinner.click();
  await today.click();
  await expect(lunch).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.selection-summary')).toContainText('2일');

  await page.clock.runFor(2000);

  await expect(today).toBeDisabled();
  await expect(lunch).toBeDisabled();
  await expect(dinner).toBeDisabled();
  await expect(lunch).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.selection-summary')).toContainText('2일');
  await tomorrow.click();
  await expect(dinner).toBeEnabled();
  await expect(dinner).toHaveAttribute('aria-pressed', 'true');
});

for (const event of ['focus', 'visibilitychange'] as const) {
  test(`타이머 실행 없이 시계가 바뀌어도 ${event} 이벤트로 한국 날짜를 갱신한다`, async ({
    page,
  }) => {
    const room = roomSnapshot();
    await freezeBeforeLoad(page);
    await mockReadOnlyRoom(page, room);
    await openRoom(page, room);
    const dateInput = page.getByLabel('다른 날짜', { exact: true });
    await expect(dateInput).toHaveAttribute('min', '2026-10-02');

    await page.clock.setSystemTime(new Date(afterMidnight));
    // setSystemTime alone must not run the midnight timer or re-render React.
    await expect(dateInput).toHaveAttribute('min', '2026-10-02');
    await page.evaluate((type) => {
      if (type === 'focus') window.dispatchEvent(new Event('focus'));
      else {
        if (document.visibilityState !== 'visible')
          throw new Error('The test requires a visible document.');
        document.dispatchEvent(new Event('visibilitychange'));
      }
    }, event);

    await expect(dateInput).toHaveAttribute('min', '2026-10-03');
    await expect(page.locator('.date-candidate .date-square b')).toHaveText([
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });
}

test('같은 참석 응답을 다시 눌러도 현재 revision을 포함해 제출한다', async ({
  page,
}) => {
  const room = roomSnapshot({
    stage: 'confirm',
    date: '2026-10-03|점심',
    confirmations: { 방장: true, 친구: false },
    attendees: ['방장'],
    regionRevision: 7,
  });
  const posts: unknown[] = [];
  await freezeBeforeLoad(page);
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ json: { room } });
    } else await route.fulfill({ json: { user: '방장', rooms: [room] } });
  });
  await openRoom(page, room);

  const confirm = page.getByRole('button', {
    name: '갈 수 있어요',
    exact: true,
  });
  await expect(confirm).toHaveAttribute('aria-pressed', 'true');
  await confirm.click();
  await expect
    .poll(() => posts)
    .toEqual([
      { type: 'confirm', roomId: room.id, value: true, regionRevision: 7 },
    ]);
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(confirm).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByText('참석 여부를 제출했어요.', { exact: true }),
  ).toBeVisible();
});

test('저장 전에 시작한 GET이 POST보다 늦게 도착해도 저장 결과를 덮어쓰지 않는다', async ({
  page,
}) => {
  const initial = roomSnapshot({
    stage: 'confirm',
    date: '2026-10-03|점심',
    confirmations: { 친구: true },
    attendees: ['친구'],
  });
  const saved: Room = {
    ...initial,
    stage: 'region',
    confirmations: { 방장: true, 친구: true },
    attendees: ['방장', '친구'],
  };
  let current = initial;
  let holdNextGet = false;
  let captureStaleRoute: (route: Route) => void = () => {};
  const staleRoute = new Promise<Route>((resolve) => {
    captureStaleRoute = resolve;
  });
  const posts: unknown[] = [];
  await freezeBeforeLoad(page, '2026-10-02T03:00:00.000Z');
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      current = saved;
      await route.fulfill({ json: { room: saved } });
    } else if (holdNextGet) {
      holdNextGet = false;
      captureStaleRoute(route);
    } else await route.fulfill({ json: { user: '방장', rooms: [current] } });
  });
  await openRoom(page, initial);
  await expect(
    page.getByRole('heading', { name: '이날, 함께할 수 있나요?' }),
  ).toBeVisible();

  holdNextGet = true;
  await page.clock.runFor(4000);
  const held = await staleRoute;
  await page.getByRole('button', { name: '갈 수 있어요', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '어디에서 만날까요?' }),
  ).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(posts).toEqual([
    { type: 'confirm', roomId: initial.id, value: true, regionRevision: 3 },
  ]);

  const receivedStale = page.waitForResponse(
    (response) => response.request() === held.request(),
  );
  await held.fulfill({ json: { user: '방장', rooms: [initial] } });
  await (await receivedStale).finished();
  await page.clock.runFor(100);
  await expect(
    page.getByRole('heading', { name: '어디에서 만날까요?' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '이날, 함께할 수 있나요?' }),
  ).toHaveCount(0);
});
