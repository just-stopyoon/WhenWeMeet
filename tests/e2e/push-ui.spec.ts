import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import type { Page, PlaywrightWorkerArgs, Request } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  test as base,
  uniqueTitle,
  type MeetingRequest,
  type Room,
  type TestAccount,
} from '../support/fixtures';
import type { MeetingSnapshot } from '../../lib/meeting-contract';

// Notification UI (issue #14 T5). Headless Chromium always reports the
// notification permission as denied and real subscribe() fails, so these
// tests replace Notification.permission, PushManager and the service worker
// registration before the page starts. Server responses are the real API/D1.
// Subscriptions go only to accounts made here, never to the 3 shared ones.

type Mode = 'unsupported' | 'denied' | 'preparing' | 'off' | 'on';
type MockOptions = {
  mode: Mode;
  // Server key of an existing ('on') subscription.
  key?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  // Keep an existing subscription whatever the mode (logout test).
  existing?: boolean;
};
type PushLog = {
  log: string[];
  holdSubscribe: boolean;
  releaseSubscribe: (() => void) | null;
  releaseReady: (() => void) | null;
  onSubscribe: 'granted' | 'denied';
  unsubscribeFails: boolean;
};

const unsupportedText =
  'iPhone은 홈 화면에 추가한 앱에서 알림을 켤 수 있어요. 공유 → 홈 화면에 추가';
const deniedText = '알림이 꺼져 있어요. 기기 설정에서 허용해 주세요.';
const promptTitle = '알림을 켜면 내 차례가 왔을 때 알려 드려요';

// Runs in the page before any app script (reused by the screen capture).
function installPushMock(options: MockOptions) {
  const control = {
    log: [] as string[],
    permission:
      options.mode === 'on'
        ? 'granted'
        : options.mode === 'denied'
          ? 'denied'
          : 'default',
    subscription: null as unknown,
    holdSubscribe: false,
    releaseSubscribe: null as (() => void) | null,
    releaseReady: null as (() => void) | null,
    onSubscribe: 'granted' as 'granted' | 'denied',
    unsubscribeFails: false,
  };
  (window as unknown as { __push: typeof control }).__push = control;
  if (options.mode === 'unsupported') {
    delete (window as Partial<Window & { PushManager: unknown }>).PushManager;
    return;
  }
  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    get: () => control.permission,
  });
  const bytes = (value: string) => {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
  };
  const makeSubscription = (serverKey: ArrayBuffer) => {
    const subscription = {
      endpoint: options.endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: serverKey },
      toJSON: () => ({
        endpoint: options.endpoint,
        expirationTime: null,
        keys: { p256dh: options.p256dh, auth: options.auth },
      }),
      unsubscribe: () => {
        control.log.push('unsubscribe');
        if (control.subscription === subscription) control.subscription = null;
        return control.unsubscribeFails
          ? Promise.reject(new Error('unsubscribe failed'))
          : Promise.resolve(true);
      },
    };
    return subscription;
  };
  if ((options.mode === 'on' || options.existing) && options.key)
    control.subscription = makeSubscription(bytes(options.key));
  const pushManager = {
    getSubscription: () => Promise.resolve(control.subscription),
    subscribe: (init: { applicationServerKey: Uint8Array }) => {
      control.log.push('subscribe');
      const run = () => {
        if (control.onSubscribe === 'denied') {
          control.permission = 'denied';
          throw new DOMException('denied', 'NotAllowedError');
        }
        control.permission = 'granted';
        control.subscription = makeSubscription(
          new Uint8Array(init.applicationServerKey).buffer,
        );
        return control.subscription;
      };
      return new Promise((resolve, reject) => {
        const settle = () => {
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        };
        if (control.holdSubscribe) control.releaseSubscribe = settle;
        else settle();
      });
    },
  };
  const registration = { pushManager, scope: location.origin + '/' };
  const ready =
    options.mode === 'preparing'
      ? new Promise((resolve) => {
          control.releaseReady = () => resolve(registration);
        })
      : Promise.resolve(registration);
  const container = navigator.serviceWorker;
  Object.defineProperty(container, 'ready', {
    configurable: true,
    get: () => ready,
  });
  container.getRegistration = () =>
    Promise.resolve(registration as unknown as ServiceWorkerRegistration);
  container.register = () =>
    Promise.resolve(registration as unknown as ServiceWorkerRegistration);
}

function deviceKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/t5-${randomUUID()}`,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

async function signUp(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
): Promise<TestAccount> {
  const origin = new URL(baseURL).origin;
  const request = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: origin },
  });
  const name = `t5${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const pin = String(1000 + Math.floor(Math.random() * 9000));
  const response = await request.post('/api/meeting', {
    data: {
      type: 'signup',
      name,
      nickname: name,
      pin,
    } satisfies MeetingRequest,
  });
  expect(response.status(), 'Push test account signup failed.').toBe(200);
  return { name, pin, request, storageState: await request.storageState() };
}

// One dedicated account per worker keeps the login/signup budget (IP limit
// 50 per 15 minutes) for the whole run; only the logout test makes another.
const test = base.extend<object, { pushAccount: TestAccount }>({
  pushAccount: [
    async ({ playwright }, provide, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (!baseURL) throw new Error('Test baseURL is required.');
      const account = await signUp(playwright, baseURL);
      try {
        await provide(account);
      } finally {
        await account.request.dispose();
      }
    },
    { scope: 'worker' },
  ],
});

async function serverKey(account: TestAccount) {
  const response = await account.request.get('/api/meeting');
  const snapshot = (await response.json()) as MeetingSnapshot;
  expect(snapshot.pushPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  return snapshot.pushPublicKey!;
}

async function openApp(
  page: Page,
  account: TestAccount,
  options: Omit<MockOptions, 'endpoint' | 'p256dh' | 'auth'> &
    Partial<Pick<MockOptions, 'endpoint'>>,
) {
  const device = { ...deviceKeys(), ...options };
  await page.context().addCookies(account.storageState.cookies);
  await page.addInitScript(installPushMock, device);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '우리 언제 만날까요?',
  );
  return device;
}

function pushLog(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __push: PushLog }).__push.log,
  );
}

function setControl(page: Page, values: Partial<PushLog>) {
  return page.evaluate((values) => {
    Object.assign((window as unknown as { __push: PushLog }).__push, values);
  }, values);
}

const isPost = (type: string) => (request: Request) =>
  new URL(request.url()).pathname === '/api/meeting' &&
  request.method() === 'POST' &&
  (request.postDataJSON() as { type?: string }).type === type;

function recordPosts(page: Page, type: string) {
  const seen: unknown[] = [];
  page.on('request', (request) => {
    if (isPost(type)(request)) seen.push(request.postDataJSON());
  });
  return seen;
}

function waitPost(page: Page, type: string) {
  return page.waitForResponse((response) => isPost(type)(response.request()));
}

async function openAccountSheet(page: Page) {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('내 계정');
  return dialog;
}

// The sheet's reading order without the handle and the close button.
function sheetTexts(page: Page) {
  return page
    .getByRole('dialog')
    .locator(':scope > :not(.sheet-handle):not(.sheet-close)')
    .allInnerTexts();
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function createInUi(page: Page, title: string): Promise<Room> {
  await page.getByRole('button', { name: '내 모임으로', exact: true }).click();
  await page
    .getByRole('button', { name: '새 모임 만들기', exact: true })
    .click();
  await page.getByLabel('모임 이름', { exact: true }).fill(title);
  const created = waitPost(page, 'create');
  await page.getByRole('button', { name: '모임 만들기', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const { room } = (await response.json()) as { room: Room };
  await expect(page.locator('header b')).toHaveText(title);
  return room;
}

async function joinInUi(page: Page, room: Room) {
  await page.goto(`/?join=${room.code}`);
  const joined = waitPost(page, 'join');
  await page
    .getByRole('button', { name: '모임 참가하기', exact: true })
    .click();
  expect((await joined).status()).toBe(200);
  await expect(page.locator('header b')).toHaveText(room.title);
}

// No prompt appears once the screen has settled after a success.
async function expectNoPrompt(page: Page) {
  await page.waitForTimeout(600);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function closeRooms(account: TestAccount, rooms: (Room | undefined)[]) {
  for (const room of rooms)
    if (room) await action(account, { type: 'close', roomId: room.id });
}

for (const [mode, row] of [
  ['unsupported', unsupportedText],
  ['denied', deniedText],
  ['preparing', '알림 켜기'],
  ['off', '알림 켜기'],
] as const) {
  test(`"내 계정" 알림 줄: ${mode} 상태는 이름 안내와 로그아웃 사이에 정해진 내용만 보인다`, async ({
    page,
    pushAccount,
  }) => {
    await openApp(page, pushAccount, { mode });
    const dialog = await openAccountSheet(page);
    expect(await sheetTexts(page)).toEqual([
      '내 계정',
      `${pushAccount.name}님으로 이용 중이에요.`,
      row,
      '로그아웃',
    ]);
    const enable = dialog.getByRole('button', { name: '알림 켜기' });
    if (mode === 'off') await expect(enable).toBeEnabled();
    else if (mode === 'preparing') await expect(enable).toBeDisabled();
    else await expect(enable).toHaveCount(0);
    await expectNoOverflow(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '설정', exact: true }),
    ).toBeFocused();
  });
}

test('"내 계정" 알림 줄: 마지막 응답에 공개 키가 없으면 알림 줄을 숨긴다', async ({
  page,
  pushAccount,
}) => {
  await page.route('/api/meeting', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as MeetingSnapshot;
    delete body.pushPublicKey;
    await route.fulfill({ response, json: body });
  });
  await openApp(page, pushAccount, { mode: 'off' });
  await openAccountSheet(page);
  expect(await sheetTexts(page)).toEqual([
    '내 계정',
    `${pushAccount.name}님으로 이용 중이에요.`,
    '로그아웃',
  ]);
});

test('켜기는 연타해도 pushSubscribe를 한 번 보내고 켜짐으로 바뀐다', async ({
  page,
  pushAccount,
}) => {
  const device = await openApp(page, pushAccount, { mode: 'off' });
  const posts = recordPosts(page, 'pushSubscribe');
  const dialog = await openAccountSheet(page);
  await setControl(page, { holdSubscribe: true });
  const enable = dialog.getByRole('button', { name: '알림 켜기' });
  await expect(enable).toBeEnabled();
  await enable.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
    button.click();
  });
  await expect(enable).toBeDisabled();
  const saved = waitPost(page, 'pushSubscribe');
  await page.evaluate(() =>
    (window as unknown as { __push: PushLog }).__push.releaseSubscribe?.(),
  );
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({});
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '끄기' })).toBeEnabled();
  expect(posts).toEqual([
    {
      type: 'pushSubscribe',
      subscription: {
        endpoint: device.endpoint,
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
    },
  ]);
  expect(
    (await pushLog(page)).filter((entry) => entry === 'subscribe'),
  ).toEqual(['subscribe']);
});

test('켜기에서 권한을 거절하면 거절 문구로 바뀌고 저장 요청을 보내지 않는다', async ({
  page,
  pushAccount,
}) => {
  await openApp(page, pushAccount, { mode: 'off' });
  const posts = recordPosts(page, 'pushSubscribe');
  const dialog = await openAccountSheet(page);
  await setControl(page, { onSubscribe: 'denied' });
  await dialog.getByRole('button', { name: '알림 켜기' }).click();
  await expect(dialog.getByText(deniedText, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toHaveCount(
    0,
  );
  expect(posts).toEqual([]);
});

test('켜기 뒤 서버 저장이 실패하면 기기 구독을 해지하고 기존 오류 토스트를 보인다', async ({
  page,
  pushAccount,
}) => {
  // The real server refuses a push host outside the known four.
  await openApp(page, pushAccount, {
    mode: 'off',
    endpoint: `https://push.example.com/t5-${randomUUID()}`,
  });
  const dialog = await openAccountSheet(page);
  const saved = waitPost(page, 'pushSubscribe');
  await dialog.getByRole('button', { name: '알림 켜기' }).click();
  const response = await saved;
  expect(response.status()).toBe(400);
  const { error } = (await response.json()) as { error: string };
  await expect(page.locator('.toast')).toHaveText(error);
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  expect(await pushLog(page)).toEqual(['subscribe', 'unsubscribe']);
});

test('끄기는 기기 구독을 해지한 뒤 pushUnsubscribe를 보내고 꺼짐으로 바뀐다', async ({
  page,
  pushAccount,
}) => {
  const resynced = waitPost(page, 'pushSubscribe');
  const device = await openApp(page, pushAccount, {
    mode: 'on',
    key: await serverKey(pushAccount),
  });
  expect((await resynced).status()).toBe(200);
  let logAtRequest: string[] = [];
  await page.route('/api/meeting', async (route) => {
    if (isPost('pushUnsubscribe')(route.request()))
      logAtRequest = await pushLog(page);
    await route.fallback();
  });
  const dialog = await openAccountSheet(page);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  const removed = waitPost(page, 'pushUnsubscribe');
  await dialog.getByRole('button', { name: '끄기' }).click();
  const response = await removed;
  expect(response.request().postDataJSON()).toEqual({
    type: 'pushUnsubscribe',
    endpoint: device.endpoint,
  });
  expect(await response.json()).toEqual({ removed: true });
  expect(logAtRequest).toEqual(['unsubscribe']);
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
});

test('로그아웃은 상태와 관계없이 기기 구독 해지를 시도한 뒤 logout을 보낸다', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Test baseURL is required.');
  // Its own account: the real logout ends this session.
  const account = await signUp(playwright, baseURL);
  try {
    const key = await serverKey(account);
    let logAtLogout: string[] | null = null;
    let failLogout = true;
    let current = page;
    await context.route('/api/meeting', async (route) => {
      if (!isPost('logout')(route.request())) return route.fallback();
      logAtLogout = await pushLog(current);
      if (failLogout)
        return route.fulfill({
          status: 503,
          json: { error: '잠시 후 다시 시도해 주세요.' },
        });
      await route.fallback();
    });

    // 1) Denied, a device subscription still there and its removal fails:
    // logout is still sent; its failure keeps the session with a toast.
    await openApp(page, account, { mode: 'denied', key, existing: true });
    await setControl(page, { unsubscribeFails: true });
    let dialog = await openAccountSheet(page);
    await dialog.getByRole('button', { name: '로그아웃' }).click();
    await expect(page.locator('.toast')).toHaveText(
      '잠시 후 다시 시도해 주세요.',
    );
    expect(logAtLogout).toEqual(['unsubscribe']);
    await expect(dialog).toHaveAccessibleName('내 계정');
    const still = await account.request.get('/api/meeting');
    expect(((await still.json()) as MeetingSnapshot).user).toBe(account.name);

    // 2) On: the device subscription is removed before the real logout.
    failLogout = false;
    logAtLogout = null;
    await page.close();
    const second = await context.newPage();
    current = second;
    await openApp(second, account, { mode: 'on', key });
    dialog = await openAccountSheet(second);
    const loggedOut = waitPost(second, 'logout');
    await dialog.getByRole('button', { name: '로그아웃' }).click();
    expect((await loggedOut).status()).toBe(200);
    expect(logAtLogout).toEqual(['unsubscribe']);
    await expect(second.getByRole('heading', { level: 1 })).toContainText(
      '반가워요!',
    );
  } finally {
    await account.request.dispose();
  }
});

test('모임 만들기·참가 직후 꺼짐이면 바텀시트가 한 번 뜨고 "나중에" 뒤에는 그 기기에서 뜨지 않는다', async ({
  page,
  accounts,
  pushAccount,
}) => {
  const [host] = accounts;
  const hosted: (Room | undefined)[] = [];
  const own: (Room | undefined)[] = [];
  try {
    hosted.push(await createRoom(host, { title: uniqueTitle('알림 참가 1') }));
    await openApp(page, pushAccount, { mode: 'off' });

    // Join: the sheet shows; Escape closes it to the screen title.
    await joinInUi(page, hosted[0]!);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName(promptTitle);
    expect(await sheetTexts(page)).toEqual([
      promptTitle,
      '알림 켜기',
      '나중에',
    ]);
    await expectNoOverflow(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

    // Escape is not "나중에": the next create still asks, then "나중에".
    own.push(await createInUi(page, uniqueTitle('알림 만들기 1')));
    await expect(dialog).toHaveAccessibleName(promptTitle);
    await dialog.getByRole('button', { name: '나중에' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

    own.push(await createInUi(page, uniqueTitle('알림 만들기 2')));
    await expectNoPrompt(page);
    hosted.push(await createRoom(host, { title: uniqueTitle('알림 참가 2') }));
    await joinInUi(page, hosted[1]!);
    await expectNoPrompt(page);
  } finally {
    await closeRooms(host, hosted);
    await closeRooms(pushAccount, own);
  }
});

test('미지원이면 성공 직후 바텀시트에 홈 화면 추가 안내와 "나중에"만 보인다', async ({
  page,
  pushAccount,
}) => {
  let room: Room | undefined;
  try {
    await openApp(page, pushAccount, { mode: 'unsupported' });
    room = await createInUi(page, uniqueTitle('알림 미지원'));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName(promptTitle);
    expect(await sheetTexts(page)).toEqual([
      promptTitle,
      unsupportedText,
      '나중에',
    ]);
    await expectNoOverflow(page);
    await dialog.getByRole('button', { name: '나중에' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  } finally {
    await closeRooms(pushAccount, [room]);
  }
});

test('켜짐·거절이면 모임을 만든 직후 바텀시트가 뜨지 않는다', async ({
  page,
  context,
  pushAccount,
}) => {
  const rooms: (Room | undefined)[] = [];
  try {
    const resynced = waitPost(page, 'pushSubscribe');
    await openApp(page, pushAccount, {
      mode: 'on',
      key: await serverKey(pushAccount),
    });
    expect((await resynced).status()).toBe(200);
    rooms.push(await createInUi(page, uniqueTitle('알림 켜짐')));
    await expectNoPrompt(page);

    const denied = await context.newPage();
    await openApp(denied, pushAccount, { mode: 'denied' });
    rooms.push(await createInUi(denied, uniqueTitle('알림 거절')));
    await expectNoPrompt(denied);
  } finally {
    await closeRooms(pushAccount, rooms);
  }
});

test('준비 중에 모임을 만들면 준비가 끝났을 때 그 모임 화면에 있을 때만 바텀시트를 띄운다', async ({
  page,
  context,
  pushAccount,
}) => {
  const release = (target: Page) =>
    target.evaluate(() =>
      (window as unknown as { __push: PushLog }).__push.releaseReady?.(),
    );
  const rooms: (Room | undefined)[] = [];
  try {
    await openApp(page, pushAccount, { mode: 'preparing' });
    rooms.push(await createInUi(page, uniqueTitle('알림 준비 중')));
    await expectNoPrompt(page);
    await release(page);
    await expect(page.getByRole('dialog')).toHaveAccessibleName(promptTitle);

    const away = await context.newPage();
    await openApp(away, pushAccount, { mode: 'preparing' });
    rooms.push(await createInUi(away, uniqueTitle('알림 준비 중 이동')));
    await away
      .getByRole('button', { name: '내 모임으로', exact: true })
      .click();
    await release(away);
    await expectNoPrompt(away);
  } finally {
    await closeRooms(pushAccount, rooms);
  }
});

test('다시 맞추기는 폴링 중 한 번만 보내고, 실패하면 꺼짐으로 보인 뒤 탭 복귀 때 다시 보낸다', async ({
  page,
  pushAccount,
}) => {
  test.setTimeout(60_000);
  let failNext = true;
  await page.route('/api/meeting', async (route) => {
    if (isPost('pushSubscribe')(route.request()) && failNext) {
      failNext = false;
      return route.fulfill({
        status: 503,
        json: { error: '잠시 후 다시 시도해 주세요.' },
      });
    }
    await route.fallback();
  });
  const posts = recordPosts(page, 'pushSubscribe');
  const first = waitPost(page, 'pushSubscribe');
  await openApp(page, pushAccount, {
    mode: 'on',
    key: await serverKey(pushAccount),
  });
  expect((await first).status()).toBe(503);
  const dialog = await openAccountSheet(page);
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  // Two 4-second polls pass without another attempt.
  for (let poll = 0; poll < 2; poll++)
    await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/meeting' &&
        response.request().method() === 'GET',
    );
  expect(posts).toHaveLength(1);

  const retried = waitPost(page, 'pushSubscribe');
  await page.evaluate(() => {
    const set = (value: DocumentVisibilityState) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => value,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set('hidden');
    set('visible');
  });
  expect((await retried).status()).toBe(200);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  await page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/meeting' &&
      response.request().method() === 'GET',
  );
  expect(posts).toHaveLength(2);
  expect(await pushLog(page)).toEqual([]);
});

test('다시 맞추기는 공개 키가 잠시 빠진 응답 뒤에도 기기 구독을 유지하고, 다른 유효 키일 때만 해지한다', async ({
  page,
  pushAccount,
}) => {
  test.setTimeout(60_000);
  const key = await serverKey(pushAccount);
  const posts = recordPosts(page, 'pushSubscribe');
  const resynced = waitPost(page, 'pushSubscribe');
  await openApp(page, pushAccount, { mode: 'on', key });
  expect((await resynced).status()).toBe(200);
  const dialog = await openAccountSheet(page);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();

  let replaceKey: ((body: MeetingSnapshot) => void) | null = (body) => {
    delete body.pushPublicKey;
  };
  await page.route('/api/meeting', async (route) => {
    if (route.request().method() !== 'GET' || !replaceKey)
      return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as MeetingSnapshot;
    replaceKey(body);
    await route.fulfill({ response, json: body });
  });
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toHaveCount(0);
  expect(await sheetTexts(page)).toEqual([
    '내 계정',
    `${pushAccount.name}님으로 이용 중이에요.`,
    '로그아웃',
  ]);
  replaceKey = null;
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  expect(await pushLog(page)).toEqual([]);
  expect(posts).toHaveLength(1);

  const other = createECDH('prime256v1');
  other.generateKeys();
  replaceKey = (body) => {
    body.pushPublicKey = other.getPublicKey().toString('base64url');
  };
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  expect(await pushLog(page)).toEqual(['unsubscribe']);
});
