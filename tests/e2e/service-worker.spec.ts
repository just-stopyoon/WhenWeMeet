import type { BrowserContext, Page, Worker } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  postAction,
  test,
  uniqueTitle,
  type Room,
} from '../support/fixtures';

// Headless Chromium cannot synthesize real push or notification click events,
// so these tests call the worker's named handlers with stand-in events,
// clients and registration objects (issue #14 T4, decision R7 ②).
type PushHandler = (event: unknown, registration: unknown) => void;
type ClickHandler = (event: unknown, clients: unknown, origin: string) => void;
type WorkerGlobals = {
  handlePush: PushHandler;
  handleNotificationClick: ClickHandler;
};

const goneToast = '종료되었거나 더 이상 참여 중인 모임이 아니에요.';

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

test('notificationclick 처리기는 열린 창을 재사용하고 없으면 새 창, 다른 출처면 /를 연다', async ({
  page,
  context,
  accounts,
}) => {
  await context.addCookies(accounts[0].storageState.cookies);
  const worker = await registeredWorker(page, context);
  const results = await worker.evaluate(async () => {
    const { handleNotificationClick } = globalThis as unknown as WorkerGlobals;
    const origin = self.location.origin;
    const run = async (data: unknown, windowUrls: string[]) => {
      const log: string[] = [];
      let waited: Promise<unknown> | undefined;
      const windows = windowUrls.map((url, index) => ({
        url,
        async focus() {
          log.push(`focus ${index}`);
          return this;
        },
        postMessage(message: unknown) {
          log.push(`message ${index} ${JSON.stringify(message)}`);
        },
      }));
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
          async openWindow(url: string) {
            log.push(`open ${url}`);
            return null;
          },
        },
        origin,
      );
      const hadWait = waited instanceof Promise;
      await waited;
      return { log, hadWait };
    };
    const room = { url: '/?room=room-1' };
    return {
      reuse: await run(room, ['https://other.example/', origin + '/?join=ABC']),
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
  expect(results.reuse).toEqual({
    log: [
      'close',
      matchAll,
      'focus 1',
      'message 1 {"type":"wwm-open-room","url":"/?room=room-1"}',
    ],
    hadWait: true,
  });
  expect(results.fresh).toEqual({
    log: ['close', matchAll, 'open /?room=room-1'],
    hadWait: true,
  });
  expect(results.foreignOnly).toEqual(results.fresh);
  expect(results.absolute).toEqual({
    log: ['close', matchAll, 'open /?room=room-2'],
    hadWait: true,
  });
  for (const name of [
    'otherOrigin',
    'protocolRelative',
    'otherPath',
    'noRoom',
    'missing',
    'wrongType',
  ] as const)
    expect(results[name], name).toEqual({
      log: ['close', matchAll, 'open /'],
      hadWait: true,
    });
});

// The page clock stays paused so the 4-second poll never refreshes the list:
// only the message handler's own fresh request can explain the result.
test('오래 열린 창에 알림 클릭 메시지가 오면 목록을 새로 받아 그 모임 또는 홈과 토스트를 보인다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let joined: Room | undefined;
  let left: Room | undefined;
  try {
    left = await createRoom(host, { title: uniqueTitle('알림 메시지 나감') });
    await action(guest, { type: 'join', code: left.code });
    await context.addCookies(guest.storageState.cookies);
    await page.clock.install({ time: new Date(Date.now() - 1000) });
    await page.clock.pauseAt(new Date());
    const worker = await registeredWorker(page, context);
    await expect(
      page.getByRole('heading', { name: left.title, exact: true }),
    ).toBeVisible();

    joined = await createRoom(host, { title: uniqueTitle('알림 메시지 참가') });
    await action(guest, { type: 'join', code: joined.code });
    const leave = await postAction(guest, {
      type: 'remove',
      roomId: left.id,
      member: guest.name,
    });
    expect(leave.status()).toBe(200);
    // The stale list still shows the left room and lacks the joined one.
    await expect(
      page.getByRole('heading', { name: left.title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: joined.title, exact: true }),
    ).toHaveCount(0);

    const click = (url: string) =>
      worker.evaluate(async (target) => {
        const { handleNotificationClick } =
          globalThis as unknown as WorkerGlobals;
        let waited: Promise<unknown> | undefined;
        handleNotificationClick(
          {
            notification: { data: { url: target }, close() {} },
            waitUntil(promise: Promise<unknown>) {
              waited = promise;
            },
          },
          (globalThis as unknown as { clients: unknown }).clients,
          self.location.origin,
        );
        await waited;
      }, url);

    await click(`/?room=${joined.id}`);
    await expect(page.locator('header b')).toHaveText(joined.title);
    await expect(page).toHaveURL(/\/$/);

    await click(`/?room=${left.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '우리 언제 만날까요?',
    );
    await expect(page.locator('.toast')).toHaveText(goneToast);
    await expect(page).toHaveURL(/\/$/);
  } finally {
    if (joined) await action(host, { type: 'close', roomId: joined.id });
    if (left) await action(host, { type: 'close', roomId: left.id });
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
