import type { BrowserContext, Page, Route, Worker } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  postAction,
  test,
  uniqueTitle,
  type Room,
  type TestAccount,
} from '../support/fixtures';

// Notification-click ordering on an open window (issue #14 T4 reviews,
// entry model .utmp/ticket-14-T4/entry-model.md). Real API/D1 responses;
// only their delivery is delayed. The page clock stays paused so the
// 4-second poll never runs unless a test advances it.
type ClickHandler = (event: unknown, clients: unknown, origin: string) => void;
type Probe = { gets: number; settled: number; messages: number };
type Fulfill = Parameters<Route['fulfill']>[0];

type Held = {
  method: string;
  type?: string;
  release: (override?: Fulfill) => Promise<void>;
};

// Counts GET calls and the moment each GET body (or failure) reaches the
// app, so tests observe processing instead of waiting a fixed time.
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe = { gets: 0, settled: 0, messages: 0 };
    (window as unknown as { __probe: Probe }).__probe = probe;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const isGet = !init?.method || init.method === 'GET';
      if (isGet) probe.gets++;
      try {
        const response = await original(input, init);
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            if (isGet) probe.settled++;
          }
        };
        return response;
      } catch (error) {
        if (isGet) probe.settled++;
        throw error;
      }
    };
  });
}

function probe(page: Page) {
  return page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
}

// Two message-channel turns: the app's continuation after the body and the
// React render it schedules both run before this resolves.
async function flush(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let turns = 0;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          if (++turns === 2) resolve();
          else channel.port2.postMessage(0);
        };
        channel.port2.postMessage(0);
      }),
  );
}

async function settled(page: Page, count: number) {
  await expect.poll(async () => (await probe(page)).settled).toBe(count);
  await flush(page);
}

// A listener added after the app's own one: when it has run, the app's
// message handler has run too.
async function countMessages(page: Page) {
  await page.evaluate(() => {
    const probe = (window as unknown as { __probe: Probe }).__probe;
    navigator.serviceWorker.addEventListener('message', () => probe.messages++);
  });
}

async function handled(page: Page, count: number) {
  await expect.poll(async () => (await probe(page)).messages).toBe(count);
}

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
      held.push({
        method,
        release: (override) => route.fulfill(override ?? { response }),
      });
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
  await installProbe(page);
  await page.clock.install({ time: new Date(Date.now() - 1000) });
  await page.clock.pauseAt(new Date());
  await page.goto('/');
  const worker = await workerFor(page, context);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '우리 언제 만날까요?',
  );
  await countMessages(page);
  return worker;
}

async function workerFor(page: Page, context: BrowserContext) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}));
  return (
    context
      .serviceWorkers()
      .find((w) => new URL(w.url()).pathname === '/sw.js') ??
    (await context.waitForEvent('serviceworker'))
  );
}

async function openFromHome(page: Page, room: Room) {
  await page
    .getByRole('button')
    .filter({
      has: page.getByRole('heading', { name: room.title, exact: true }),
    })
    .click();
  await expect(page.locator('header b')).toHaveText(room.title);
}

async function signIn(page: Page, account: TestAccount) {
  await page.getByLabel('아이디', { exact: true }).fill(account.name);
  await page
    .getByLabel('숫자 4자리 비밀번호', { exact: true })
    .fill(account.pin);
  const signedIn = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      (response.request().postDataJSON() as { type?: string }).type === 'login',
  );
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  // The response body is read by the app before the next two turns end.
  expect(await (await signedIn).finished()).toBeNull();
  await flush(page);
}

const goneToast = '종료되었거나 더 이상 참여 중인 모임이 아니에요.';

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
    const before = (await probe(page)).settled;
    await requests.held[0].release();
    await settled(page, before + 1);
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
    const gets = (await probe(page)).gets;
    requests.hold((method) => method === 'GET');
    await click(worker, { url: `/?room=${room.id}` });
    await handled(page, 1);
    expect((await probe(page)).gets).toBe(gets);
    await requests.held[0].release();
    await expectLogin(page);
    // The GET deferred by the save runs only after the logout finished.
    await requests.waitHeld(2);
    const before = (await probe(page)).settled;
    await requests.held[1].release();
    await settled(page, before + 1);
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
      const before = (await probe(page)).settled;
      if (order === 'older-first') {
        await older.release();
        await settled(page, before + 1);
        await expect(page.locator('.toast')).toHaveCount(0);
        await expect(page.locator('header b')).toHaveText('언제 만날래');
        await newer.release();
      } else {
        await newer.release();
        await expect(page.locator('header b')).toHaveText(second.title);
        await older.release();
        await settled(page, before + 2);
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
    expect(errors).toEqual([]);
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

// Entry model rows: first list in flight + message, join/root on login.
for (const message of ['join', 'root'] as const) {
  test(`첫 조회 중 열린 창 ${message === 'join' ? 'join' : '루트'} 메시지가 오면 첫 주소의 초대 대신 그 메시지대로 연다`, async ({
    page,
    context,
    accounts,
  }) => {
    const [host, guest] = accounts;
    let oldInvite: Room | undefined;
    let newInvite: Room | undefined;
    let member: Room | undefined;
    try {
      oldInvite = await createRoom(host, {
        title: uniqueTitle('첫 주소 초대'),
      });
      newInvite = await createRoom(host, { title: uniqueTitle('메시지 초대') });
      member = await createRoom(guest, { title: uniqueTitle('메시지 방') });
      await context.addCookies(guest.storageState.cookies);
      await installProbe(page);
      const requests = holdRequests(page);
      await requests.ready;
      requests.hold((method) => method === 'GET');
      await page.goto(`/?join=${oldInvite.code}`);
      const worker = await workerFor(page, context);
      await countMessages(page);
      await requests.waitHeld(1);
      await click(
        worker,
        message === 'join'
          ? { url: `/?room=${member.id}&join=${newInvite.code}` }
          : undefined,
      );
      await handled(page, 1);
      requests.hold(null);
      await requests.held[0].release();
      if (message === 'join') {
        await expect(page.locator('header b')).toHaveText('모임 참가');
        await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
          newInvite.code,
        );
      } else {
        await expect(page.getByRole('heading', { level: 1 })).toContainText(
          '우리 언제 만날까요?',
        );
        await expect(page.getByLabel('초대 코드', { exact: true })).toHaveCount(
          0,
        );
        await expect(page).toHaveURL(/\/$/);
      }
      await expect(page.locator('.toast')).toHaveCount(0);
    } finally {
      if (oldInvite)
        await action(host, { type: 'close', roomId: oldInvite.id });
      if (newInvite)
        await action(host, { type: 'close', roomId: newInvite.id });
      if (member) await action(guest, { type: 'close', roomId: member.id });
    }
  });
}

test('알림 조회의 손상된 목록은 적용하지 않고 다음 정상 목록에서 목적지를 한 번 연다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('손상 목록 알림') });
    await action(guest, { type: 'join', code: room.code });
    const requests = holdRequests(page);
    await requests.ready;
    const worker = await signedInHome(page, context, guest);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const broken: Fulfill[] = [
      { json: { user: guest.name } },
      { json: { user: guest.name, rooms: [null] } },
      { json: { user: guest.name, rooms: [{ id: 7, members: [] }] } },
    ];
    for (const [index, body] of broken.entries()) {
      requests.hold((method) => method === 'GET');
      await click(worker, { url: `/?room=${room.id}` });
      await requests.waitHeld(index + 1);
      requests.hold(null);
      const before = (await probe(page)).settled;
      await requests.held[index].release(body);
      await settled(page, before + 1);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        '우리 언제 만날까요?',
      );
    }
    expect(errors).toEqual([]);
    // The next poll reads a valid list and consumes the kept entry once.
    await page.clock.runFor(4000);
    await expect(page.locator('header b')).toHaveText(room.title);
    await expect(page).toHaveURL(/\/$/);
    expect(errors).toEqual([]);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('보던 모임에서 강퇴된 뒤 다른 모임 알림을 누르면 그 모임만 열고 이탈 토스트를 보이지 않는다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let first: Room | undefined;
  let second: Room | undefined;
  try {
    first = await createRoom(host, { title: uniqueTitle('강퇴된 모임') });
    second = await createRoom(host, { title: uniqueTitle('알림 모임') });
    await action(guest, { type: 'join', code: first.code });
    await action(guest, { type: 'join', code: second.code });
    await signedInHome(page, context, guest);
    const worker = await workerFor(page, context);
    await openFromHome(page, first);
    const removed = await postAction(host, {
      type: 'remove',
      roomId: first.id,
      member: guest.name,
    });
    expect(removed.status()).toBe(200);
    const before = (await probe(page)).settled;
    await click(worker, { url: `/?room=${second.id}` });
    await settled(page, before + 1);
    await expect(page.locator('header b')).toHaveText(second.title);
    await expect(page.locator('.toast')).toHaveCount(0);
  } finally {
    if (first) await action(host, { type: 'close', roomId: first.id });
    if (second) await action(host, { type: 'close', roomId: second.id });
  }
});

test('보던 모임을 나가는 저장 중 온 다른 모임 알림은 저장 뒤 그 모임을 열고 이탈 토스트로 덮지 않는다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let first: Room | undefined;
  let second: Room | undefined;
  try {
    first = await createRoom(host, { title: uniqueTitle('나가는 모임') });
    second = await createRoom(host, { title: uniqueTitle('저장 뒤 알림') });
    await action(guest, { type: 'join', code: first.code });
    await action(guest, { type: 'join', code: second.code });
    const requests = holdRequests(page);
    await requests.ready;
    const worker = await signedInHome(page, context, guest);
    await openFromHome(page, first);
    page.on('dialog', (dialog) => void dialog.accept());
    requests.hold((method, type) => method === 'POST' && type === 'remove');
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '모임 나가기' })
      .click();
    await requests.waitHeld(1);
    await click(worker, { url: `/?room=${second.id}` });
    await handled(page, 1);
    requests.hold(null);
    const before = (await probe(page)).settled;
    await requests.held[0].release();
    await settled(page, before + 1);
    await expect(page.locator('header b')).toHaveText(second.title);
    await expect(page.locator('.toast')).not.toHaveText(goneToast);
  } finally {
    if (first) await action(host, { type: 'close', roomId: first.id });
    if (second) await action(host, { type: 'close', roomId: second.id });
  }
});

test('새 알림 조회로 모임을 연 뒤 이전 알림 조회가 실패해도 연결 오류 토스트를 보이지 않는다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let first: Room | undefined;
  let second: Room | undefined;
  try {
    first = await createRoom(host, { title: uniqueTitle('실패할 알림') });
    second = await createRoom(host, { title: uniqueTitle('성공할 알림') });
    await action(guest, { type: 'join', code: first.code });
    await action(guest, { type: 'join', code: second.code });
    const requests = holdRequests(page);
    await requests.ready;
    const worker = await signedInHome(page, context, guest);
    requests.hold((method) => method === 'GET');
    await click(worker, { url: `/?room=${first.id}` });
    await requests.waitHeld(1);
    requests.hold(null);
    await click(worker, { url: `/?room=${second.id}` });
    await expect(page.locator('header b')).toHaveText(second.title);
    const before = (await probe(page)).settled;
    await requests.held[0].release({
      status: 503,
      json: { error: '늦은 실패' },
    });
    await settled(page, before + 1);
    await expect(page.locator('header b')).toHaveText(second.title);
    await expect(page.locator('.toast')).toHaveCount(0);
  } finally {
    if (first) await action(host, { type: 'close', roomId: first.id });
    if (second) await action(host, { type: 'close', roomId: second.id });
  }
});

// Signing in again with a join code left in the form (one flow keeps the
// login count low: the test server allows 50 sign-ins per run). A kept entry
// decides; without one the existing rule leads to the join screen.
test('폼에 참가 코드가 남은 채 다시 로그인하면 보관한 진입이 있을 때만 그 진입을 따른다', async ({
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

    // No entry: the leftover code leads to the join screen, as before T4.
    await logout(page);
    await expectLogin(page);
    await signIn(page, guest);
    await expect(page.locator('header b')).toHaveText('모임 참가');
    await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
      'OLDCODE00000',
    );

    // Root message while signed out: home, not the leftover code.
    await logout(page);
    await expectLogin(page);
    await click(worker, undefined);
    await handled(page, 1);
    await expectLogin(page);
    await signIn(page, guest);
    await expect(page.locator('header b')).toHaveText('언제 만날래');
    await expect(page.getByLabel('초대 코드', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '우리 언제 만날까요?',
    );

    // Room message while signed out: that room, not the leftover code.
    await logout(page);
    await expectLogin(page);
    await click(worker, { url: `/?room=${room.id}` });
    await handled(page, 2);
    await signIn(page, guest);
    await expect(page.locator('header b')).toHaveText(room.title);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});
