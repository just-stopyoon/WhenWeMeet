import type { BrowserContext, Page, Worker } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  test,
  uniqueTitle,
  type Room,
} from '../support/fixtures';

// Most tests call the worker's named handlers directly with stand-in events,
// clients and registration objects (issue #14 T4, decision R7 ②). One push
// also goes through the registered listener via CDP (last test); notification
// clicks are not synthesized.
type PushHandler = (event: unknown, registration: unknown) => void;
type ClickHandler = (event: unknown, clients: unknown, origin: string) => void;
type WorkerGlobals = {
  handlePush: PushHandler;
  handleNotificationClick: ClickHandler;
};

async function registeredWorker(
  page: Page,
  context: BrowserContext,
): Promise<Worker> {
  await page.goto('/');
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(new URL(scope).pathname).toBe('/');
  const worker =
    context
      .serviceWorkers()
      .find((w) => new URL(w.url()).pathname === '/sw.js') ??
    (await context.waitForEvent('serviceworker'));
  expect(new URL(worker.url()).pathname).toBe('/sw.js');
  return worker;
}

test('앱을 열면 service worker를 등록하고 push 처리기는 페이로드대로 알림을 보인다', async ({
  page,
  context,
  accounts,
}) => {
  await context.addCookies(accounts[0].storageState.cookies);
  const worker = await registeredWorker(page, context);
  const results = await worker.evaluate(async () => {
    const { handlePush } = globalThis as unknown as WorkerGlobals;
    const run = (data: unknown) => {
      const shown: { title: string; options: unknown }[] = [];
      const marker = Promise.resolve('shown');
      let waited: unknown;
      handlePush(
        {
          data,
          waitUntil(promise: unknown) {
            waited = promise;
          },
        },
        {
          showNotification(title: string, options: unknown) {
            shown.push({ title, options });
            return marker;
          },
        },
      );
      return { shown, waitedOnShow: waited === marker };
    };
    const json = (value: unknown) => ({ json: () => value });
    const broken = {
      json: () => {
        throw new SyntaxError('broken');
      },
    };
    return {
      valid: run(
        json({
          title: '연남 모임',
          body: '날짜가 정해졌어요 · 12월 3일 (목) 저녁. 지역을 투표해 주세요.',
          tag: 'room-1',
          url: '/?room=room-1',
        }),
      ),
      missing: run(null),
      broken: run(broken),
      array: run(json(['x'])),
      number: run(json(7)),
      emptyTitle: run(json({ title: '', body: 3, tag: 4, url: 5 })),
    };
  });
  expect(results.valid).toEqual({
    shown: [
      {
        title: '연남 모임',
        options: {
          body: '날짜가 정해졌어요 · 12월 3일 (목) 저녁. 지역을 투표해 주세요.',
          tag: 'room-1',
          icon: '/icons/icon-192.png',
          data: { url: '/?room=room-1' },
        },
      },
    ],
    waitedOnShow: true,
  });
  const fallback = {
    shown: [
      {
        title: '언제 만날래',
        options: {
          body: '새 소식이 있어요.',
          icon: '/icons/icon-192.png',
          data: { url: '/' },
        },
      },
    ],
    waitedOnShow: true,
  };
  for (const name of [
    'missing',
    'broken',
    'array',
    'number',
    'emptyTitle',
  ] as const)
    expect(results[name], name).toEqual(fallback);
});

// The stand-in clients grant one window permission per click, as Chromium
// does for one notificationclick: focus() and openWindow() each use it up.
// openWindow() stays pending until released, so the test sees whether
// waitUntil covers the new window opening (issue #14 T4 final review).
test('notificationclick 처리기는 열린 창을 여는 주소로 이동한 뒤 앞으로 가져오고 거절되거나 창이 없으면 새 창, 다른 출처면 /를 연다', async ({
  page,
  context,
  accounts,
}) => {
  await context.addCookies(accounts[0].storageState.cookies);
  const worker = await registeredWorker(page, context);
  const results = await worker.evaluate(async () => {
    const { handleNotificationClick } = globalThis as unknown as WorkerGlobals;
    const origin = self.location.origin;
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
    const run = async (
      data: unknown,
      windowUrls: string[],
      { navigation = 'ok', grants = 1 } = {} as {
        navigation?: 'ok' | 'refused';
        grants?: number;
      },
    ) => {
      const log: string[] = [];
      let permission = grants;
      const spend = (what: string) => {
        if (permission < 1) {
          log.push(`${what} refused`);
          throw new DOMException('Not allowed', 'InvalidAccessError');
        }
        permission--;
        log.push(what);
      };
      const opens: (() => void)[] = [];
      const windows = windowUrls.map((url, index) => ({
        url,
        async focus() {
          spend(`focus ${index}`);
          return this;
        },
        async navigate(target: string) {
          log.push(`navigate ${index} ${target}`);
          if (navigation === 'refused')
            throw new TypeError(
              "This service worker is not the client's active service worker.",
            );
          return {
            url: origin + target,
            async focus() {
              spend(`focus moved ${index}`);
              return this;
            },
          };
        },
      }));
      let waited: Promise<unknown> | undefined;
      handleNotificationClick(
        {
          notification: {
            data,
            close() {
              log.push('close');
            },
          },
          waitUntil(promise: Promise<unknown>) {
            waited = promise;
          },
        },
        {
          async matchAll(options: unknown) {
            log.push(`matchAll ${JSON.stringify(options)}`);
            return windows;
          },
          openWindow(url: string) {
            spend(`open ${url}`);
            return new Promise((resolve) => opens.push(() => resolve(null)));
          },
        },
        origin,
      );
      const hadWait = waited instanceof Promise;
      let state = 'pending';
      waited?.then(
        () => (state = 'done'),
        () => (state = 'rejected'),
      );
      for (let i = 0; i < 5; i++) await turn();
      const beforeOpenDone = state;
      opens.forEach((release) => release());
      for (let i = 0; i < 5; i++) await turn();
      return { log, hadWait, beforeOpenDone, settled: state };
    };
    const room = { url: '/?room=room-1' };
    return {
      reuse: await run(room, ['https://other.example/', origin + '/?join=ABC']),
      refused: await run(room, [origin + '/'], { navigation: 'refused' }),
      focusRefused: await run(room, [origin + '/'], { grants: 0 }),
      reuseRoot: await run({ url: 'https://evil.example/?room=room-1' }, [
        origin + '/?room=room-1',
      ]),
      fresh: await run(room, []),
      foreignOnly: await run(room, ['https://other.example/']),
      absolute: await run({ url: origin + '/?room=room-2' }, []),
      otherOrigin: await run({ url: 'https://evil.example/?room=room-1' }, []),
      protocolRelative: await run({ url: '//evil.example/?room=room-1' }, []),
      otherPath: await run({ url: '/rooms?room=room-1' }, []),
      noRoom: await run({ url: '/?join=ABC' }, []),
      missing: await run(undefined, []),
      wrongType: await run({ url: 7 }, []),
    };
  });
  const matchAll = 'matchAll {"type":"window","includeUncontrolled":true}';
  // Moving needs no permission; the one grant goes to focusing the moved window.
  expect(results.reuse).toEqual({
    log: ['close', matchAll, 'navigate 1 /?room=room-1', 'focus moved 1'],
    hadWait: true,
    beforeOpenDone: 'done',
    settled: 'done',
  });
  // A window not controlled yet refuses navigate(): the grant opens a new one.
  expect(results.refused).toEqual({
    log: ['close', matchAll, 'navigate 0 /?room=room-1', 'open /?room=room-1'],
    hadWait: true,
    beforeOpenDone: 'pending',
    settled: 'done',
  });
  // A refused focus is not a failed move: no new window, the click completes.
  expect(results.focusRefused).toEqual({
    log: [
      'close',
      matchAll,
      'navigate 0 /?room=room-1',
      'focus moved 0 refused',
    ],
    hadWait: true,
    beforeOpenDone: 'done',
    settled: 'done',
  });
  expect(results.reuseRoot).toEqual({
    log: ['close', matchAll, 'navigate 0 /', 'focus moved 0'],
    hadWait: true,
    beforeOpenDone: 'done',
    settled: 'done',
  });
  const opened = (url: string) => ({
    log: ['close', matchAll, `open ${url}`],
    hadWait: true,
    beforeOpenDone: 'pending',
    settled: 'done',
  });
  expect(results.fresh).toEqual(opened('/?room=room-1'));
  expect(results.foreignOnly).toEqual(results.fresh);
  expect(results.absolute).toEqual(opened('/?room=room-2'));
  for (const name of [
    'otherOrigin',
    'protocolRelative',
    'otherPath',
    'noRoom',
    'missing',
    'wrongType',
  ] as const)
    expect(results[name], name).toEqual(opened('/'));
});

// The real registered worker moves a window it controls (after a reload);
// the page then takes the /?room= entry path. Focus needs a real click's
// user activation, so it is refused here and moving still goes ahead.
test('실제 등록된 worker는 제어하는 열린 창을 알림 주소로 이동해 그 모임 또는 홈을 연다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('알림 창 이동') });
    await action(guest, { type: 'join', code: room.code });
    await context.addCookies(guest.storageState.cookies);
    const worker = await registeredWorker(page, context);
    await page.reload();
    expect(
      await page.evaluate(() => !!navigator.serviceWorker.controller),
    ).toBe(true);
    await expect(
      page.getByRole('heading', { name: room.title, exact: true }),
    ).toBeVisible();

    const click = (data: unknown) =>
      worker.evaluate(async (notificationData) => {
        const { handleNotificationClick } =
          globalThis as unknown as WorkerGlobals;
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

    const pages = context.pages().length;
    await click({ url: `/?room=${room.id}` });
    await expect(page.locator('header b')).toHaveText(room.title);
    await expect(page).toHaveURL(/\/$/);

    await click({ url: `https://evil.example/?room=${room.id}` });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '우리 언제 만날까요?',
    );
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    expect(context.pages()).toHaveLength(pages);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

// One synthesized push through the real registered listener (CDP
// ServiceWorker.deliverPushMessage), so the listener must call the handler.
// Only the display is replaced; OS notifications are out of reach here.
test('등록된 push 리스너는 합성 push 메시지로 처리기를 거쳐 알림을 보인다', async ({
  page,
  context,
  accounts,
}) => {
  await context.addCookies(accounts[0].storageState.cookies);
  const cdp = await context.newCDPSession(page);
  const registrations: { registrationId: string; scopeURL: string }[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => {
    registrations.push(...event.registrations);
  });
  await cdp.send('ServiceWorker.enable');
  const worker = await registeredWorker(page, context);
  const origin = new URL(worker.url()).origin;
  await expect
    .poll(() => registrations.some((r) => r.scopeURL === origin + '/'))
    .toBe(true);
  const registrationId = registrations.find(
    (r) => r.scopeURL === origin + '/',
  )!.registrationId;
  await worker.evaluate(() => {
    const scope = globalThis as unknown as {
      shownByListener: unknown[];
      registration: { showNotification: unknown };
    };
    scope.shownByListener = [];
    scope.registration.showNotification = async (
      title: string,
      options: unknown,
    ) => {
      scope.shownByListener.push({ title, options });
    };
  });
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId,
    data: JSON.stringify({
      title: '합성 모임',
      body: '모두 일정을 제출했어요. 날짜를 정해 주세요.',
      tag: 'room-9',
      url: '/?room=room-9',
    }),
  });
  await expect
    .poll(() =>
      worker.evaluate(
        () =>
          (globalThis as unknown as { shownByListener: unknown[] })
            .shownByListener,
      ),
    )
    .toEqual([
      {
        title: '합성 모임',
        options: {
          body: '모두 일정을 제출했어요. 날짜를 정해 주세요.',
          tag: 'room-9',
          icon: '/icons/icon-192.png',
          data: { url: '/?room=room-9' },
        },
      },
    ]);
});
