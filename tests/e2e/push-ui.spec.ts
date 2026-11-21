import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import type {
  Page,
  PlaywrightWorkerArgs,
  Request,
  Response,
} from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  test,
  uniqueTitle,
  type MeetingRequest,
  type Room,
  type TestAccount,
} from '../support/fixtures';
import type { MeetingSnapshot } from '../../lib/meeting-contract';

// Notification UI (issue #14 T5). Headless Chromium always reports the
// notification permission as denied and real subscribe() fails, so these
// tests replace Notification.permission, PushManager and the service worker
// registration before the page starts. Server responses are the real API/D1;
// only the race tests stand in for another account's login/logout responses
// (the sign-in limit is 50 per IP per 15 minutes for the whole run).
// Subscriptions go only to the account made here, never to the 3 shared ones.

type Mode = 'unsupported' | 'denied' | 'preparing' | 'off' | 'on';
type MockOptions = {
  mode: Mode;
  // Server key of an existing subscription ('on' or `existing`).
  key?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  // Keep an existing subscription whatever the mode (logout test).
  existing?: boolean;
  // The existing subscription does not say which server key it used.
  unknownKey?: boolean;
  // The page's first subscription lookup waits for releaseLookup().
  holdFirstLookup?: boolean;
};
type PushControl = {
  log: string[];
  subscription: unknown;
  lookups: number;
  holdSubscribe: boolean;
  releaseSubscribe: (() => void) | null;
  holdNextLookup: boolean;
  releaseLookup: (() => void) | null;
  failNextLookup: boolean;
  holdUnsubscribe: boolean;
  releaseUnsubscribe: (() => void) | null;
  releaseReady: (() => void) | null;
  onSubscribe: 'granted' | 'denied';
  unsubscribeFails: boolean;
};

const unsupportedText =
  'iPhone은 홈 화면에 추가한 앱에서 알림을 켤 수 있어요. 공유 → 홈 화면에 추가';
const deniedText = '알림이 꺼져 있어요. 기기 설정에서 허용해 주세요.';
const promptTitle = '알림을 켜면 내 차례가 왔을 때 알려 드려요';
const offFailed = '알림을 끄지 못했어요. 다시 시도해 주세요.';
const other = 'otherdeviceuser';

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
    lookups: 0,
    holdSubscribe: false,
    releaseSubscribe: null as (() => void) | null,
    holdNextLookup: !!options.holdFirstLookup,
    releaseLookup: null as (() => void) | null,
    failNextLookup: false,
    holdUnsubscribe: false,
    releaseUnsubscribe: null as (() => void) | null,
    heldUnsubscribes: [] as (() => void)[],
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
  const makeSubscription = (serverKey: ArrayBuffer | null) => {
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
        const settle = (
          resolve: (value: boolean) => void,
          reject: (error: Error) => void,
        ) => {
          // A failed removal keeps the subscription on the device.
          if (control.unsubscribeFails) reject(new Error('unsubscribe failed'));
          else {
            if (control.subscription === subscription)
              control.subscription = null;
            resolve(true);
          }
        };
        return new Promise<boolean>((resolve, reject) => {
          if (control.holdUnsubscribe) {
            // Every held call settles together (끄기 and a logout attempt).
            control.heldUnsubscribes.push(() => settle(resolve, reject));
            control.releaseUnsubscribe = () => {
              control.holdUnsubscribe = false;
              for (const run of control.heldUnsubscribes.splice(0)) run();
            };
          } else settle(resolve, reject);
        });
      },
    };
    return subscription;
  };
  if ((options.mode === 'on' || options.existing) && options.key)
    control.subscription = makeSubscription(
      options.unknownKey ? null : bytes(options.key),
    );
  const pushManager = {
    getSubscription: () =>
      new Promise((resolve, reject) => {
        const settle = () => {
          control.lookups++;
          if (control.failNextLookup) {
            control.failNextLookup = false;
            reject(new DOMException('lookup failed', 'AbortError'));
          } else resolve(control.subscription);
        };
        if (control.holdNextLookup) {
          control.holdNextLookup = false;
          control.releaseLookup = settle;
        } else settle();
      }),
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

// One dedicated account per worker, made on first use and reused through
// the cookie (same worker as the other files, so the 3 shared accounts are
// not signed up again). The last test logs it out for real and drops it.
let cached: TestAccount | undefined;
async function pushAccount(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
): Promise<TestAccount> {
  if (cached) return cached;
  if (!baseURL) throw new Error('Test baseURL is required.');
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
  cached = { name, pin, request, storageState: await request.storageState() };
  return cached;
}

async function serverKey(account: TestAccount) {
  const response = await account.request.get('/api/meeting');
  const snapshot = (await response.json()) as MeetingSnapshot;
  expect(snapshot.pushPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  return snapshot.pushPublicKey!;
}

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Request seam for one page: rewrite GET snapshots, hold or answer chosen
// POST types, and record each POST with the device log at that moment.
type Router = {
  user?: string;
  key?: string;
  stripKey: boolean;
  hold: Partial<Record<string, Promise<void>>>;
  failOnce: Set<string>;
  fake: Partial<Record<string, { status: number; json: unknown }>>;
  seen: { type: string; body: unknown; log: string[]; at: number }[];
};
async function installRouter(page: Page): Promise<Router> {
  const router: Router = {
    stripKey: false,
    hold: {},
    failOnce: new Set(),
    fake: {},
    seen: [],
  };
  await page.route('/api/meeting', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      if (!router.user && !router.key && !router.stripKey)
        return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as MeetingSnapshot;
      if (router.user) {
        body.user = router.user;
        body.nickname = router.user;
        body.rooms = [];
      }
      if (router.stripKey) delete body.pushPublicKey;
      else if (router.key) body.pushPublicKey = router.key;
      return route.fulfill({ response, json: body });
    }
    const body = request.postDataJSON() as { type: string };
    const at = Date.now();
    router.seen.push({
      type: body.type,
      body,
      log: await pushLog(page).catch(() => []),
      at,
    });
    const hold = router.hold[body.type];
    if (hold) await hold;
    if (router.failOnce.delete(body.type))
      return route.fulfill({
        status: 503,
        json: { error: '잠시 후 다시 시도해 주세요.' },
      });
    const fake = router.fake[body.type];
    if (fake) return route.fulfill({ status: fake.status, json: fake.json });
    return route.fallback();
  });
  return router;
}
const posts = (router: Router, type: string) =>
  router.seen.filter((entry) => entry.type === type);

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

// 'on' starts with a re-sync; the page is on once that save answered.
async function openOn(page: Page, account: TestAccount, key: string) {
  const resynced = waitPost(page, 'pushSubscribe');
  const device = await openApp(page, account, { mode: 'on', key });
  expect((await resynced).status()).toBe(200);
  return device;
}

function control(page: Page) {
  return page.evaluate(() => {
    const { log, lookups, subscription } = (
      window as unknown as { __push: PushControl }
    ).__push;
    return { log: [...log], lookups, subscribed: !!subscription };
  });
}
async function pushLog(page: Page) {
  return (await control(page)).log;
}

function setControl(page: Page, values: Partial<PushControl>) {
  return page.evaluate((values) => {
    Object.assign(
      (window as unknown as { __push: PushControl }).__push,
      values,
    );
  }, values);
}

function release(
  page: Page,
  name:
    | 'releaseSubscribe'
    | 'releaseLookup'
    | 'releaseUnsubscribe'
    | 'releaseReady',
) {
  return page.evaluate(
    (name) => (window as unknown as { __push: PushControl }).__push[name]?.(),
    name,
  );
}

const isPost = (type: string) => (request: Request) =>
  new URL(request.url()).pathname === '/api/meeting' &&
  request.method() === 'POST' &&
  (request.postDataJSON() as { type?: string }).type === type;
const isGet = (response: Response) =>
  new URL(response.url()).pathname === '/api/meeting' &&
  response.request().method() === 'GET';

function waitPost(page: Page, type: string) {
  return page.waitForResponse((response) => isPost(type)(response.request()));
}

async function openAccountSheet(page: Page) {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('내 계정');
  return dialog;
}

async function closeSheet(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
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

// One more poll answered and painted after the screen changed: any sheet the
// app was going to open for the earlier state is open by then.
async function settle(page: Page) {
  await page.waitForResponse(isGet);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function expectNoPrompt(page: Page) {
  await settle(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

// The account sheet's notification row before an action, then closed.
async function expectRow(
  page: Page,
  row: 'on' | 'off' | 'preparing' | 'denied',
) {
  const dialog = await openAccountSheet(page);
  if (row === 'on')
    await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  else if (row === 'denied')
    await expect(dialog.getByText(deniedText, { exact: true })).toBeVisible();
  else {
    const enable = dialog.getByRole('button', { name: '알림 켜기' });
    if (row === 'off') await expect(enable).toBeEnabled();
    else await expect(enable).toBeDisabled();
  }
  await closeSheet(page);
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

// Another account takes over this tab: logout and login answers stand in
// (the real session stays), and later GETs report the other account.
async function switchAccount(page: Page, router: Router, key: string) {
  router.fake.logout = { status: 200, json: {} };
  router.fake.login = {
    status: 200,
    json: { user: other, nickname: other, rooms: [], pushPublicKey: key },
  };
  const dialog = page.getByRole('dialog');
  if ((await dialog.count()) === 0) await openAccountSheet(page);
  await dialog.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '반가워요!',
  );
  router.user = other;
  await page.getByLabel('아이디', { exact: true }).fill(other);
  await page.getByLabel('숫자 4자리 비밀번호', { exact: true }).fill('1234');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    `${other}님`,
  );
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
    playwright,
    baseURL,
  }) => {
    const account = await pushAccount(playwright, baseURL);
    await openApp(page, account, { mode });
    const dialog = await openAccountSheet(page);
    expect(await sheetTexts(page)).toEqual([
      '내 계정',
      `${account.name}님으로 이용 중이에요.`,
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
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  router.stripKey = true;
  await openApp(page, account, { mode: 'off' });
  await openAccountSheet(page);
  expect(await sheetTexts(page)).toEqual([
    '내 계정',
    `${account.name}님으로 이용 중이에요.`,
    '로그아웃',
  ]);
});

test('켜기는 연타해도 pushSubscribe를 한 번 보내고 켜짐으로 바뀐다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  const device = await openApp(page, account, { mode: 'off' });
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
  await release(page, 'releaseSubscribe');
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({});
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '끄기' })).toBeEnabled();
  expect(posts(router, 'pushSubscribe').map((entry) => entry.body)).toEqual([
    {
      type: 'pushSubscribe',
      subscription: {
        endpoint: device.endpoint,
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
    },
  ]);
  expect(await pushLog(page)).toEqual(['subscribe']);
});

test('켜기에서 권한을 거절하면 거절 문구로 바뀌고 저장 요청을 보내지 않는다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  await openApp(page, account, { mode: 'off' });
  const dialog = await openAccountSheet(page);
  await setControl(page, { onSubscribe: 'denied' });
  await dialog.getByRole('button', { name: '알림 켜기' }).click();
  await expect(dialog.getByText(deniedText, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toHaveCount(
    0,
  );
  expect(router.seen).toEqual([]);
});

test('켜기 뒤 서버 저장이 실패하면 기기 구독을 해지하고 기존 오류 토스트를 보인다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  // The real server refuses a push host outside the known four.
  await openApp(page, account, {
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
  expect(await control(page)).toMatchObject({
    log: ['subscribe', 'unsubscribe'],
    subscribed: false,
  });
});

test('끄기는 기기 구독을 해지한 뒤 pushUnsubscribe를 보내고 꺼짐으로 바뀐다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  const device = await openOn(page, account, await serverKey(account));
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
  expect(posts(router, 'pushUnsubscribe')[0]!.log).toEqual(['unsubscribe']);
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
});

test('끄기에서 기기 해지가 실패하면 서버 삭제를 보내지 않고 켜짐과 오류를 보이며, 탭 복귀에도 다시 등록하지 않고 다시 끌 수 있다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  await openOn(page, account, await serverKey(account));
  await setControl(page, { unsubscribeFails: true });
  const dialog = await openAccountSheet(page);
  await dialog.getByRole('button', { name: '끄기' }).click();
  await expect(page.locator('.toast')).toHaveText(offFailed);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  expect(await control(page)).toMatchObject({
    log: ['unsubscribe'],
    subscribed: true,
  });
  expect(posts(router, 'pushUnsubscribe')).toEqual([]);

  const before = (await control(page)).lookups;
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
  await expect
    .poll(async () => (await control(page)).lookups)
    .toBeGreaterThan(before);
  await settle(page);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();

  await setControl(page, { unsubscribeFails: false });
  const removed = waitPost(page, 'pushUnsubscribe');
  await dialog.getByRole('button', { name: '끄기' }).click();
  expect(await (await removed).json()).toEqual({ removed: true });
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
});

test('켜기 중 이 탭의 계정이 바뀌면 이전 계정의 subscribe 결과로 저장·해지하지 않는다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const key = await serverKey(account);
  const router = await installRouter(page);
  await openApp(page, account, { mode: 'off' });
  const dialog = await openAccountSheet(page);
  await setControl(page, { holdSubscribe: true });
  await dialog.getByRole('button', { name: '알림 켜기' }).click();
  await switchAccount(page, router, key);
  const loggedIn = router.seen.length;
  const saved = waitPost(page, 'pushSubscribe');
  await release(page, 'releaseSubscribe');
  // The new account's own re-sync registers the device once.
  expect((await saved).status()).toBe(200);
  await expectRow(page, 'on');
  expect(router.seen.slice(loggedIn).map((entry) => entry.type)).toEqual([
    'pushSubscribe',
  ]);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);
  expect(await pushLog(page)).toEqual(['subscribe']);
});

test('끄기 중 이 탭의 계정이 바뀌면 늦게 끝난 기기 해지 뒤 서버 삭제를 보내지 않는다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const key = await serverKey(account);
  const router = await installRouter(page);
  await openOn(page, account, key);
  await setControl(page, { holdUnsubscribe: true });
  const dialog = await openAccountSheet(page);
  await dialog.getByRole('button', { name: '끄기' }).click();
  await switchAccount(page, router, key);
  await release(page, 'releaseUnsubscribe');
  await settle(page);
  expect(posts(router, 'pushUnsubscribe')).toEqual([]);
});

test('로그아웃은 기기 조회를 기다리지 않고 곧바로 logout을 보내고, 늦게 끝난 조회로 다음 계정의 구독을 해지하지 않는다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const key = await serverKey(account);
  const router = await installRouter(page);
  await openOn(page, account, key);
  await openAccountSheet(page);
  await setControl(page, { holdNextLookup: true });
  const resynced = waitPost(page, 'pushSubscribe');
  const clicked = Date.now();
  await switchAccount(page, router, key);
  // Sent while the device lookup is still held, without a 3-second wait.
  const [logout] = posts(router, 'logout');
  expect(logout!.log).toEqual([]);
  expect(logout!.at - clicked).toBeLessThan(2000);
  expect((await resynced).status()).toBe(200);
  await expectRow(page, 'on');
  const before = (await control(page)).lookups;
  await release(page, 'releaseLookup');
  await expect.poll(async () => (await control(page)).lookups).toBe(before + 1);
  await settle(page);
  expect(await control(page)).toMatchObject({ log: [], subscribed: true });
  await expectRow(page, 'on');
});

test('다른 탭에서 계정이 바뀌면(폴링) 같은 기기 구독도 새 계정으로 다시 등록한 뒤에만 켜짐을 보인다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  await openOn(page, account, await serverKey(account));
  const held = deferred();
  router.hold.pushSubscribe = held.promise;
  router.user = other;
  const dialog = await openAccountSheet(page);
  await expect(dialog).toContainText(`${other}님으로 이용 중이에요.`);
  await expect.poll(() => posts(router, 'pushSubscribe').length).toBe(2);
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeVisible();
  const saved = waitPost(page, 'pushSubscribe');
  held.resolve();
  expect((await saved).status()).toBe(200);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();

  // Signed out by a poll: no row, no device work.
  router.user = undefined;
  router.hold = {};
  await closeSheet(page);
  await page.context().clearCookies();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '반가워요!',
  );
  expect(await pushLog(page)).toEqual([]);
});

test('다시 맞추기는 폴링 중 한 번만 보내고, 실패하면 꺼짐으로 보인 뒤 탭 복귀 때 다시 보낸다', async ({
  page,
  playwright,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  router.failOnce.add('pushSubscribe');
  const first = waitPost(page, 'pushSubscribe');
  await openApp(page, account, { mode: 'on', key: await serverKey(account) });
  expect((await first).status()).toBe(503);
  const dialog = await openAccountSheet(page);
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  // Two 4-second polls pass without another attempt.
  for (let poll = 0; poll < 2; poll++) await page.waitForResponse(isGet);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);

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
  await page.waitForResponse(isGet);
  expect(posts(router, 'pushSubscribe')).toHaveLength(2);
  expect(await pushLog(page)).toEqual([]);
});

test('진행 중인 다시 맞추기에 탭 복귀가 겹쳐도 같은 쌍을 다시 보내지 않는다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  const held = deferred();
  router.hold.pushSubscribe = held.promise;
  await openApp(page, account, { mode: 'on', key: await serverKey(account) });
  await expect.poll(() => posts(router, 'pushSubscribe').length).toBe(1);
  const before = (await control(page)).lookups;
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
  await expect
    .poll(async () => (await control(page)).lookups)
    .toBeGreaterThan(before);
  await settle(page);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);
  const saved = waitPost(page, 'pushSubscribe');
  held.resolve();
  expect((await saved).status()).toBe(200);
  await expectRow(page, 'on');
  await settle(page);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);
});

test('다시 맞추기는 공개 키가 빠지거나 손상된 응답·표기만 다른 같은 키에는 기기 구독을 유지하고, 검증된 다른 키일 때만 해지한다', async ({
  page,
  playwright,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const account = await pushAccount(playwright, baseURL);
  const key = await serverKey(account);
  const router = await installRouter(page);
  await openOn(page, account, key);
  const dialog = await openAccountSheet(page);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  const noRow = ['내 계정', `${account.name}님으로 이용 중이에요.`, '로그아웃'];

  router.stripKey = true;
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toHaveCount(0);
  expect(await sheetTexts(page)).toEqual(noRow);
  router.stripKey = false;
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();

  // 0x04 followed by zeros has the right length but is not a P-256 point.
  router.key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString(
    'base64url',
  );
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toHaveCount(0);
  expect(await sheetTexts(page)).toEqual(noRow);
  await settle(page);

  // The same 65 bytes spelled with different unused trailing bits.
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const respelled =
    key.slice(0, -1) + alphabet[alphabet.indexOf(key.at(-1)!) ^ 1];
  expect(Buffer.from(respelled, 'base64url')).toEqual(
    Buffer.from(key, 'base64url'),
  );
  router.key = respelled;
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  await settle(page);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
  expect(await pushLog(page)).toEqual([]);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);

  const otherKey = createECDH('prime256v1');
  otherKey.generateKeys();
  router.key = otherKey.getPublicKey().toString('base64url');
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  expect(await control(page)).toMatchObject({
    log: ['unsubscribe'],
    subscribed: false,
  });
});

test('기기 구독의 서버 키를 알 수 없으면 켜짐으로 보이거나 자동 등록·해지하지 않고, 켜기를 누르면 그 키로 켜진다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  await openApp(page, account, {
    mode: 'on',
    key: await serverKey(account),
    unknownKey: true,
  });
  const dialog = await openAccountSheet(page);
  await expect(dialog.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  await settle(page);
  expect(router.seen).toEqual([]);
  expect(await pushLog(page)).toEqual([]);
  const saved = waitPost(page, 'pushSubscribe');
  await dialog.getByRole('button', { name: '알림 켜기' }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog.getByText('알림 켜짐', { exact: true })).toBeVisible();
});

test('로그아웃은 진행 중인 저장이 끝난 뒤 logout을 한 번 보내고, 로그아웃 중에는 알림 켜기를 시작하지 않는다', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  // The real session stays: only this tab's logout answer stands in.
  router.fake.logout = { status: 200, json: {} };
  await openOn(page, account, await serverKey(account));

  // 1) A save in flight (끄기's pushUnsubscribe) when logout is pressed.
  const held = deferred();
  router.hold.pushUnsubscribe = held.promise;
  let dialog = await openAccountSheet(page);
  await dialog.getByRole('button', { name: '끄기' }).click();
  await expect.poll(() => posts(router, 'pushUnsubscribe').length).toBe(1);
  // The saving state blocks pointer input; a keyboard press still reaches it.
  await dialog
    .getByRole('button', { name: '로그아웃' })
    .evaluate((button: HTMLButtonElement) => button.click());
  // Polling pauses during a save, so wait two frames instead of a poll.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(posts(router, 'logout')).toEqual([]);
  held.resolve();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '반가워요!',
  );
  expect(posts(router, 'logout')).toHaveLength(1);

  // 2) 알림 켜기 pressed while the logout request is still out.
  const second = await context.newPage();
  const other = await installRouter(second);
  const waiting = deferred();
  other.hold.logout = waiting.promise;
  other.fake.logout = { status: 200, json: {} };
  await openApp(second, account, { mode: 'off' });
  dialog = await openAccountSheet(second);
  await dialog.getByRole('button', { name: '로그아웃' }).click();
  await expect.poll(() => posts(other, 'logout').length).toBe(1);
  await dialog
    .getByRole('button', { name: '알림 켜기' })
    .evaluate((button: HTMLButtonElement) => button.click());
  waiting.resolve();
  await expect(second.getByRole('heading', { level: 1 })).toContainText(
    '반가워요!',
  );
  expect(await pushLog(second)).toEqual([]);
  expect(posts(other, 'pushSubscribe')).toEqual([]);
});

test('탭 복귀의 구독 조회가 실패하면 이전 구독으로 등록하지 않고 꺼짐으로 본다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  router.failOnce.add('pushSubscribe');
  const first = waitPost(page, 'pushSubscribe');
  await openApp(page, account, { mode: 'on', key: await serverKey(account) });
  expect((await first).status()).toBe(503);
  // The device loses the subscription and the next lookup fails.
  await page.evaluate(() => {
    const push = (window as unknown as { __push: PushControl }).__push;
    push.subscription = null;
    push.failNextLookup = true;
  });
  const before = (await control(page)).lookups;
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
  await expect
    .poll(async () => (await control(page)).lookups)
    .toBeGreaterThan(before);
  await settle(page);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);
  await expectRow(page, 'off');
});

test('먼저 시작한 조회가 끝나지 않아도 최신 조회가 성공하면 다시 맞추기를 한 번 보낸다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  await openApp(page, account, {
    mode: 'on',
    key: await serverKey(account),
    holdFirstLookup: true,
  });
  await expect.poll(() => posts(router, 'pushSubscribe').length).toBe(1);
  await expectRow(page, 'on');
  await release(page, 'releaseLookup');
  await settle(page);
  expect(posts(router, 'pushSubscribe')).toHaveLength(1);
  await expectRow(page, 'on');
});

test('모임 만들기·참가 직후 꺼짐이면 바텀시트가 한 번 뜨고 "나중에" 뒤에는 그 기기에서 뜨지 않는다', async ({
  page,
  accounts,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const [host] = accounts;
  const hosted: (Room | undefined)[] = [];
  const own: (Room | undefined)[] = [];
  try {
    hosted.push(await createRoom(host, { title: uniqueTitle('알림 참가 1') }));
    await openApp(page, account, { mode: 'off' });
    await expectRow(page, 'off');

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
    await closeRooms(account, own);
  }
});

test('미지원이면 성공 직후 바텀시트에 홈 화면 추가 안내와 "나중에"만 보인다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  let room: Room | undefined;
  try {
    await openApp(page, account, { mode: 'unsupported' });
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
    await closeRooms(account, [room]);
  }
});

test('켜짐·거절이면 모임을 만든 직후 바텀시트가 뜨지 않는다', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const rooms: (Room | undefined)[] = [];
  try {
    await openOn(page, account, await serverKey(account));
    await expectRow(page, 'on');
    rooms.push(await createInUi(page, uniqueTitle('알림 켜짐')));
    await expectNoPrompt(page);

    const denied = await context.newPage();
    await openApp(denied, account, { mode: 'denied' });
    await expectRow(denied, 'denied');
    rooms.push(await createInUi(denied, uniqueTitle('알림 거절')));
    await expectNoPrompt(denied);
  } finally {
    await closeRooms(account, rooms);
  }
});

test('준비 중에 모임을 만들면 준비가 끝났을 때 그 모임 화면에 있을 때만, 다른 시트가 닫힌 뒤 바텀시트를 띄운다', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const rooms: (Room | undefined)[] = [];
  try {
    await openApp(page, account, { mode: 'preparing' });
    await expectRow(page, 'preparing');
    rooms.push(await createInUi(page, uniqueTitle('알림 준비 중')));
    await expectNoPrompt(page);
    await release(page, 'releaseReady');
    await expect(page.getByRole('dialog')).toHaveAccessibleName(promptTitle);
    await closeSheet(page);

    // Another sheet open when the lookup ends: the prompt waits for it.
    const waiting = await context.newPage();
    await openApp(waiting, account, { mode: 'preparing' });
    rooms.push(await createInUi(waiting, uniqueTitle('알림 준비 중 시트')));
    await waiting.getByRole('button', { name: '설정', exact: true }).click();
    await expect(waiting.getByRole('dialog')).toHaveAccessibleName('모임 관리');
    await release(waiting, 'releaseReady');
    await expect
      .poll(async () => (await control(waiting)).lookups)
      .toBeGreaterThan(0);
    await settle(waiting);
    await expect(waiting.getByRole('dialog')).toHaveAccessibleName('모임 관리');
    await waiting.keyboard.press('Escape');
    await expect(waiting.getByRole('dialog')).toHaveAccessibleName(promptTitle);

    const away = await context.newPage();
    await openApp(away, account, { mode: 'preparing' });
    rooms.push(await createInUi(away, uniqueTitle('알림 준비 중 이동')));
    await away
      .getByRole('button', { name: '내 모임으로', exact: true })
      .click();
    await release(away, 'releaseReady');
    await expect
      .poll(async () => (await control(away)).lookups)
      .toBeGreaterThan(0);
    await expectNoPrompt(away);
  } finally {
    await closeRooms(account, rooms);
  }
});

test('성공 직후 바텀시트가 열린 채 시트가 없는 상태로 바뀌면 닫고 화면 제목으로 돌아간다', async ({
  page,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const router = await installRouter(page);
  let room: Room | undefined;
  try {
    await openApp(page, account, { mode: 'off' });
    room = await createInUi(page, uniqueTitle('알림 시트 닫힘'));
    await expect(page.getByRole('dialog')).toHaveAccessibleName(promptTitle);
    router.stripKey = true;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  } finally {
    await closeRooms(account, [room]);
  }
});

// Last in the file: the real logout ends the cached account's session.
test('로그아웃은 상태와 관계없이 기기 구독 해지를 시도한 뒤 logout을 보낸다', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  const account = await pushAccount(playwright, baseURL);
  const key = await serverKey(account);
  const router = await installRouter(page);
  router.fake.logout = {
    status: 503,
    json: { error: '잠시 후 다시 시도해 주세요.' },
  };

  // 1) Denied, a device subscription still there and its removal fails:
  // logout is still sent; its failure keeps the session with a toast.
  await openApp(page, account, { mode: 'denied', key, existing: true });
  await setControl(page, { unsubscribeFails: true });
  let dialog = await openAccountSheet(page);
  await dialog.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.locator('.toast')).toHaveText(
    '잠시 후 다시 시도해 주세요.',
  );
  expect(posts(router, 'logout').map((entry) => entry.log)).toEqual([
    ['unsubscribe'],
  ]);
  expect((await control(page)).subscribed).toBe(true);
  await expect(dialog).toHaveAccessibleName('내 계정');
  const still = await account.request.get('/api/meeting');
  expect(((await still.json()) as MeetingSnapshot).user).toBe(account.name);
  await page.close();

  // 2) On: the device subscription is removed before the real logout.
  const second = await context.newPage();
  const real = await installRouter(second);
  await openOn(second, account, key);
  dialog = await openAccountSheet(second);
  const loggedOut = waitPost(second, 'logout');
  await dialog.getByRole('button', { name: '로그아웃' }).click();
  cached = undefined;
  expect((await loggedOut).status()).toBe(200);
  expect(posts(real, 'logout').map((entry) => entry.log)).toEqual([
    ['unsubscribe'],
  ]);
  await expect(second.getByRole('heading', { level: 1 })).toContainText(
    '반가워요!',
  );
  await account.request.dispose();
});
