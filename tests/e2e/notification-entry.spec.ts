import type { BrowserContext, Page, Route, Worker } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  test,
  uniqueTitle,
  type Room,
  type TestAccount,
} from '../support/fixtures';

// Notification-click ordering on an open window (issue #14 T4 review). Real
// API/D1 responses; only their delivery is delayed. The page clock stays
// paused so the 4-second poll never runs unless a test advances it.
type ClickHandler = (event: unknown, clients: unknown, origin: string) => void;

type Held = { method: string; type?: string; release: () => Promise<void> };

// Holds matching /api/meeting requests. A held GET is fetched from the real
// server at once, so its body reflects the moment the browser sent it.
function holdRequests(page: Page) {
  const held: Held[] = [];
  const started: string[] = [];
  let match: ((method: string, type?: string) => boolean) | null = null;
  const ready = page.route('**/api/meeting', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const type =
      method === 'POST'
        ? (request.postDataJSON() as { type?: string }).type
        : undefined;
    started.push(type ? `${method} ${type}` : method);
    if (!match?.(method, type)) return route.continue();
    if (method === 'GET') {
      const response = await route.fetch();
      held.push({ method, release: () => route.fulfill({ response }) });
    } else
      held.push({
        method,
        type,
        release: async () => {
          const response = await route.fetch();
          await route.fulfill({ response });
        },
      });
  });
  return {
    ready,
    held,
    started,
    hold(next: ((method: string, type?: string) => boolean) | null) {
      match = next;
    },
    async waitHeld(count: number) {
      await expect.poll(() => held.length).toBe(count);
    },
  };
}

// Tests that log out sign in a separate session, so the shared fixture
// session stays valid for the API calls of later tests.
async function signedInHome(
  page: Page,
  context: BrowserContext,
  account: TestAccount,
  session: 'shared' | 'separate' = 'shared',
): Promise<Worker> {
  if (session === 'shared')
    await context.addCookies(account.storageState.cookies);
  else {
    const login = await context.request.post('/api/meeting', {
      headers: { Origin: 'http://127.0.0.1:4317' },
      data: { type: 'login', name: account.name, pin: account.pin },
    });
    expect(login.status()).toBe(200);
  }
  await page.clock.install({ time: new Date(Date.now() - 1000) });
  await page.clock.pauseAt(new Date());
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}));
  const worker =
    context
      .serviceWorkers()
      .find((w) => new URL(w.url()).pathname === '/sw.js') ??
    (await context.waitForEvent('serviceworker'));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '우리 언제 만날까요?',
  );
  return worker;
}

// Runs the real notificationclick handler with the real clients list.
function click(worker: Worker, data: unknown) {
  return worker.evaluate(async (notificationData) => {
    const { handleNotificationClick } = globalThis as unknown as {
      handleNotificationClick: ClickHandler;
    };
    let waited: Promise<unknown> | undefined;
    handleNotificationClick(
      {
        notification: { data: notificationData, close() {} },
        waitUntil(promise: Promise<unknown>) {
          waited = promise;
        },
      },
      (globalThis as unknown as { clients: unknown }).clients,
      self.location.origin,
    );
    await waited;
  }, data);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '로그아웃' })
    .click();
}

async function expectLogin(page: Page) {
  await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
  await expect(page.locator('header b')).toHaveText('언제 만날래');
  await expect(page.locator('.toast')).toHaveCount(0);
}

test('알림 조회 중 로그아웃이 끝나면 늦게 온 옛 목록으로 모임을 열지 않는다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('늦은 알림 조회') });
    await action(guest, { type: 'join', code: room.code });
    const requests = holdRequests(page);
    await requests.ready;
    const worker = await signedInHome(page, context, guest, 'separate');
    requests.hold((method) => method === 'GET');
    await click(worker, { url: `/?room=${room.id}` });
    await requests.waitHeld(1);
    requests.hold(null);
    await logout(page);
    await expectLogin(page);
    await requests.held[0].release();
    await page.waitForTimeout(300);
    await expectLogin(page);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('로그아웃 저장 중에 온 알림은 저장이 끝난 뒤 새로 조회하고 옛 세션으로 되돌리지 않는다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('저장 중 알림') });
    await action(guest, { type: 'join', code: room.code });
    const requests = holdRequests(page);
    await requests.ready;
    const worker = await signedInHome(page, context, guest, 'separate');
    requests.hold((method, type) => method === 'POST' && type === 'logout');
    await logout(page);
    await requests.waitHeld(1);
    const before = requests.started.length;
    requests.hold((method) => method === 'GET');
    await click(worker, { url: `/?room=${room.id}` });
    await page.waitForTimeout(300);
    expect(requests.started.slice(before)).toEqual([]);
    await requests.held[0].release();
    await expectLogin(page);
    // The GET deferred by the save runs only after the logout finished.
    await requests.waitHeld(2);
    await requests.held[1].release();
    await page.waitForTimeout(300);
    await expectLogin(page);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

for (const order of ['older-first', 'newer-first'] as const) {
  test(`알림 두 개의 조회가 ${order === 'older-first' ? '먼저 보낸 순서로' : '반대 순서로'} 끝나도 마지막 알림의 모임만 연다`, async ({
    page,
    context,
    accounts,
  }) => {
    const [host, guest] = accounts;
    let first: Room | undefined;
    let second: Room | undefined;
    try {
      first = await createRoom(host, { title: uniqueTitle('알림 순서 A') });
      second = await createRoom(host, { title: uniqueTitle('알림 순서 B') });
      await action(guest, { type: 'join', code: first.code });
      const requests = holdRequests(page);
      await requests.ready;
      const worker = await signedInHome(page, context, guest);
      requests.hold((method) => method === 'GET');
      await click(worker, { url: `/?room=${first.id}` });
      await requests.waitHeld(1);
      // B is joined after A's list was read, so only B's list contains it.
      await action(guest, { type: 'join', code: second.code });
      await click(worker, { url: `/?room=${second.id}` });
      await requests.waitHeld(2);
      requests.hold(null);
      const [older, newer] = requests.held;
      if (order === 'older-first') {
        await older.release();
        await page.waitForTimeout(300);
        await expect(page.locator('.toast')).toHaveCount(0);
        await expect(page.locator('header b')).toHaveText('언제 만날래');
        await newer.release();
      } else {
        await newer.release();
        await expect(page.locator('header b')).toHaveText(second.title);
        await older.release();
        await page.waitForTimeout(300);
      }
      await expect(page.locator('header b')).toHaveText(second.title);
      await expect(page.locator('.toast')).toHaveCount(0);
      await expect(page).toHaveURL(/\/$/);
    } finally {
      if (first) await action(host, { type: 'close', roomId: first.id });
      if (second) await action(host, { type: 'close', roomId: second.id });
    }
  });
}

test('첫 조회 재시도 중 온 알림은 처음 주소 대신 그 알림의 모임을 연다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let first: Room | undefined;
  let second: Room | undefined;
  try {
    first = await createRoom(host, { title: uniqueTitle('재시도 주소 A') });
    second = await createRoom(host, { title: uniqueTitle('재시도 알림 B') });
    await action(guest, { type: 'join', code: first.code });
    await action(guest, { type: 'join', code: second.code });
    await context.addCookies(guest.storageState.cookies);
    let gets = 0;
    let releaseRetry: (() => Promise<void>) | undefined;
    await page.route('**/api/meeting', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      gets++;
      if (gets === 1)
        return route.fulfill({
          status: 503,
          json: { error: '첫 조회만 실패' },
        });
      if (gets === 2) {
        const response = await route.fetch();
        releaseRetry = () => route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await page.goto(`/?room=${first.id}`);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}));
    const worker =
      context
        .serviceWorkers()
        .find((w) => new URL(w.url()).pathname === '/sw.js') ??
      (await context.waitForEvent('serviceworker'));
    await page
      .getByRole('button', { name: '다시 연결하기', exact: true })
      .click();
    await expect.poll(() => releaseRetry !== undefined).toBe(true);
    await click(worker, { url: `/?room=${second.id}` });
    await releaseRetry!();
    await expect(page.locator('header b')).toHaveText(second.title);
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  } finally {
    if (first) await action(host, { type: 'close', roomId: first.id });
    if (second) await action(host, { type: 'close', roomId: second.id });
  }
});

test('열린 창에서 주소가 없거나 다른 출처인 알림을 누르면 홈으로 가고 시트를 닫는다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('잘못된 알림 주소') });
    const worker = await signedInHome(page, context, host);
    for (const data of [
      undefined,
      { url: 'https://evil.example/?room=' + room.id },
      { url: '//evil.example/?room=' + room.id },
    ]) {
      await page
        .getByRole('button')
        .filter({
          has: page.getByRole('heading', { name: room.title, exact: true }),
        })
        .click();
      await expect(page.locator('header b')).toHaveText(room.title);
      await page.getByRole('button', { name: '설정', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await click(worker, data);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        '우리 언제 만날까요?',
      );
      await expect(page.locator('.toast')).toHaveCount(0);
    }
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('손상된 메시지 주소는 처리되지 않은 오류 없이 홈으로 보낸다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('손상 메시지') });
    await signedInHome(page, context, host);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page
      .getByRole('button')
      .filter({
        has: page.getByRole('heading', { name: room.title, exact: true }),
      })
      .click();
    await expect(page.locator('header b')).toHaveText(room.title);
    // Posts the message the way the worker does, with a malformed address.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'wwm-open-room', url: 'http://[' },
          source: registration.active,
        }),
      );
    });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '우리 언제 만날까요?',
    );
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('지난 참가 코드가 남아 있어도 로그인 뒤에는 마지막 알림의 모임을 연다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('지난 코드 알림') });
    await action(guest, { type: 'join', code: room.code });
    const worker = await signedInHome(page, context, guest, 'separate');
    await page.getByRole('button', { name: '코드로 참가' }).click();
    await page.getByLabel('초대 코드', { exact: true }).fill('OLDCODE00000');
    await page
      .getByRole('button', { name: '내 모임으로', exact: true })
      .click();
    await logout(page);
    await expectLogin(page);
    await click(worker, { url: `/?room=${room.id}` });
    await page.getByLabel('아이디', { exact: true }).fill(guest.name);
    await page
      .getByLabel('숫자 4자리 비밀번호', { exact: true })
      .fill(guest.pin);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.locator('header b')).toHaveText(room.title);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('열린 창의 알림 주소에 join이 함께 있으면 참가 화면이 우선이다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let invited: Room | undefined;
  let member: Room | undefined;
  try {
    invited = await createRoom(host, { title: uniqueTitle('메시지 초대') });
    member = await createRoom(guest, { title: uniqueTitle('메시지 내 방') });
    const worker = await signedInHome(page, context, guest);
    await click(worker, { url: `/?room=${member.id}&join=${invited.code}` });
    await expect(page.locator('header b')).toHaveText('모임 참가');
    await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
      invited.code,
    );
  } finally {
    if (invited) await action(host, { type: 'close', roomId: invited.id });
    if (member) await action(guest, { type: 'close', roomId: member.id });
  }
});

test('시트가 열린 채 같은 모임·다른 모임 알림을 누르면 시트를 닫고 그 모임을 보인다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  let first: Room | undefined;
  let second: Room | undefined;
  try {
    first = await createRoom(host, { title: uniqueTitle('시트 알림 A') });
    second = await createRoom(host, { title: uniqueTitle('시트 알림 B') });
    const worker = await signedInHome(page, context, host);
    await page
      .getByRole('button')
      .filter({
        has: page.getByRole('heading', { name: first.title, exact: true }),
      })
      .click();
    for (const target of [first, second]) {
      await page.getByRole('button', { name: '설정', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await click(worker, { url: `/?room=${target.id}` });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('header b')).toHaveText(target.title);
    }
  } finally {
    if (first) await action(host, { type: 'close', roomId: first.id });
    if (second) await action(host, { type: 'close', roomId: second.id });
  }
});
