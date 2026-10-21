import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';

const invite = 'ABC123DEF456';
const failureHeading = '서버에 연결하지 못했어요';

async function pauseClock(page: Page) {
  await page.clock.install({ time: new Date('2026-10-21T03:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-21T03:00:01Z'));
}

async function capture(page: Page, info: TestInfo, name: string) {
  const sizes = await page.evaluate(() => ({
    content: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
    viewport: window.innerWidth,
  }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
  await expect(page.getByRole('button')).toBeInViewport();
  const directory = 'outputs/verification/initial-connection-retry';
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${info.project.name}-${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

for (const failure of ['network', 'http', 'html', 'json', 'shape'] as const) {
  test(`${failure} 초기 오류는 수동 재시도 후 정상 로그인 화면으로 복구한다`, async ({
    page,
  }, info) => {
    let gets = 0;
    const posts: unknown[] = [];
    const held: Route[] = [];
    await pauseClock(page);
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
      if (gets > 1) {
        held.push(route);
        return;
      }
      if (failure === 'network') await route.abort('failed');
      else if (failure === 'http')
        await route.fulfill({ status: 503, json: { error: '임시 연결 오류' } });
      else if (failure === 'html')
        await route.fulfill({
          status: 502,
          contentType: 'text/html',
          body: '<h1>Bad Gateway</h1>',
        });
      else if (failure === 'json')
        await route.fulfill({
          contentType: 'application/json',
          body: '{broken',
        });
      else await route.fulfill({ json: { user: null, rooms: null } });
    });
    await page.goto(`/?join=${invite}`);
    const heading = page.getByRole('heading', {
      name: failureHeading,
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.getByLabel('아이디', { exact: true })).toHaveCount(0);
    await page.clock.runFor(8000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(gets).toBe(1);
    expect(posts).toEqual([]);
    if (failure === 'http') await capture(page, info, 'error');
    await page.keyboard.press('Tab');
    const retry = page.getByRole('button', {
      name: '다시 연결하기',
      exact: true,
    });
    await expect(retry).toBeFocused();
    await retry.press('Enter');
    await expect.poll(() => held.length).toBe(1);
    await expect(
      page.getByRole('button', { name: '연결 중…', exact: true }),
    ).toBeDisabled();
    if (failure === 'http') await capture(page, info, 'retrying');
    expect(gets).toBe(2);
    await held[0].fulfill({ json: { user: '', rooms: [] } });
    await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    await page.clock.runFor(35_000);
    await expect(heading).toHaveCount(0);
    expect(gets).toBe(2);
    expect(posts).toEqual([]);
  });
}

test('연속 클릭과 재실패에도 재시도 요청을 하나씩 실행하고 최초 초대를 보존한다', async ({
  page,
}) => {
  let gets = 0;
  const held: Route[] = [];
  await pauseClock(page);
  await page.route('**/api/meeting', async (route) => {
    expect(route.request().method()).toBe('GET');
    gets++;
    if (gets === 1)
      await route.fulfill({ status: 503, json: { error: '일시 오류' } });
    else held.push(route);
  });
  await page.goto(`/?join=${invite.toLowerCase()}`);
  await expect(
    page.getByRole('heading', { name: failureHeading }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.history.replaceState(null, '', '/?join=CHANGED00000');
    const button = document.querySelector<HTMLButtonElement>(
      '.connection-view button',
    );
    button?.click();
    button?.click();
  });
  await expect.poll(() => held.length).toBe(1);
  expect(gets).toBe(2);
  await held[0].fulfill({ status: 503, json: { error: '다시 실패' } });
  await expect(
    page.getByRole('button', { name: '다시 연결하기' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '다시 연결하기' }).click();
  await expect.poll(() => held.length).toBe(2);
  await held[1].fulfill({
    json: { user: 'member-id', nickname: '친구', rooms: [] },
  });
  await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
    invite,
  );
  expect(gets).toBe(3);
});

for (const signup of [false, true]) {
  test(`초기 복구 뒤 ${signup ? '회원가입' : '로그인'} 실패와 모드 전환에도 초대를 유지한다`, async ({
    page,
  }) => {
    let gets = 0;
    const posts: { type: string }[] = [];
    await pauseClock(page);
    await page.route('**/api/meeting', async (route) => {
      if (route.request().method() === 'GET') {
        gets++;
        await route.fulfill(
          gets === 1
            ? { status: 503, json: { error: '일시 오류' } }
            : { json: { user: '', rooms: [] } },
        );
        return;
      }
      posts.push(route.request().postDataJSON() as { type: string });
      await route.fulfill(
        posts.length === 1
          ? { status: 400, json: { error: '인증을 다시 시도해 주세요.' } }
          : { json: { user: 'my-id', nickname: '내 이름', rooms: [] } },
      );
    });
    await page.goto(`/?join=${invite}`);
    await expect(
      page.getByRole('heading', { name: failureHeading }),
    ).toBeVisible();
    await page.evaluate(() => window.history.replaceState(null, '', '/'));
    await page.getByRole('button', { name: '다시 연결하기' }).click();
    await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '처음이에요 · 회원가입' }).click();
    await page
      .getByRole('button', { name: '이미 계정이 있어요 · 로그인' })
      .click();
    if (signup) {
      await page.getByRole('button', { name: '처음이에요 · 회원가입' }).click();
      await page
        .getByPlaceholder('친구들이 알아볼 수 있는 이름')
        .fill('내 이름');
    }
    await page.getByLabel('아이디', { exact: true }).fill('my-id');
    await page.getByLabel('숫자 4자리 비밀번호', { exact: true }).fill('0123');
    const submit = page.getByRole('button', {
      name: signup ? '회원가입' : '로그인',
      exact: true,
    });
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText(
      '인증을 다시 시도해 주세요.',
    );
    await submit.click();
    await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
      invite,
    );
    expect(posts.map((post) => post.type)).toEqual(
      signup ? ['signup', 'signup'] : ['login', 'login'],
    );
    expect(gets).toBe(2);
  });
}

test('최초 초대가 없으면 재시도 중 URL에 생긴 코드를 사용하지 않고 홈으로 복구한다', async ({
  page,
}) => {
  let gets = 0;
  await page.route('**/api/meeting', async (route) => {
    expect(route.request().method()).toBe('GET');
    gets++;
    await route.fulfill(
      gets === 1
        ? { status: 503, json: { error: '일시 오류' } }
        : { json: { user: 'my-id', nickname: '내 이름', rooms: [] } },
    );
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: failureHeading }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.history.replaceState(null, '', '/?join=LATER0000000'),
  );
  await page.getByRole('button', { name: '다시 연결하기' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '내 이름님',
  );
  await expect(page.getByLabel('초대 코드', { exact: true })).toHaveCount(0);
});

test('각 초기 요청은 30초에 만료되고 취소를 무시한 이전 성공·실패도 새 결과를 바꾸지 않는다', async ({
  page,
}) => {
  await pauseClock(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const held: {
      signal?: AbortSignal | null;
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
    }[] = [];
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.href,
      );
      if (
        url.pathname === '/api/meeting' &&
        init?.method !== 'POST' &&
        held.length < 2
      )
        return new Promise<Response>((resolve, reject) =>
          held.push({ signal: init?.signal, resolve, reject }),
        );
      return originalFetch(input, init);
    };
    Reflect.set(window, 'initialTransport', {
      aborted: () => held.map((request) => request.signal?.aborted),
      settle: () => {
        held[0].resolve(
          new Response(
            JSON.stringify({
              user: 'old-id',
              nickname: '이전 응답',
              rooms: [],
            }),
          ),
        );
        held[1].reject(new Error('이전 실패'));
      },
    });
  });
  let actualGets = 0;
  await page.route('**/api/meeting', async (route) => {
    expect(route.request().method()).toBe('GET');
    actualGets++;
    await route.fulfill({
      json: { user: 'new-id', nickname: '최신 응답', rooms: [] },
    });
  });
  await page.goto('/');
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      page.getByRole('heading', {
        name: attempt ? '다시 연결하고 있어요' : '모임을 준비하고 있어요',
      }),
    ).toBeVisible();
    await page.clock.runFor(29_999);
    await expect(
      page.getByRole('heading', { name: failureHeading }),
    ).toHaveCount(0);
    expect(actualGets).toBe(0);
    await page.clock.runFor(1);
    await expect(
      page.getByRole('heading', { name: failureHeading }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      '연결이 오래 걸리고 있어요',
    );
    await page.getByRole('button', { name: '다시 연결하기' }).click();
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '최신 응답님',
  );
  const aborted = await page.evaluate(() => {
    const transport = Reflect.get(window, 'initialTransport') as {
      aborted: () => boolean[];
      settle: () => void;
    };
    const result = transport.aborted();
    transport.settle();
    return result;
  });
  expect(aborted).toEqual([true, true]);
  await page.clock.runFor(1000);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '최신 응답님',
  );
  expect(actualGets).toBe(1);
});

test('초기 복구 뒤 30초 넘게 지연된 일반 폴링 응답도 정상 반영한다', async ({
  page,
}) => {
  let gets = 0;
  const held: Route[] = [];
  await pauseClock(page);
  await page.route('**/api/meeting', async (route) => {
    expect(route.request().method()).toBe('GET');
    gets++;
    if (gets === 1)
      await route.fulfill({ status: 503, json: { error: '일시 오류' } });
    else if (gets === 2)
      await route.fulfill({
        json: { user: 'my-id', nickname: '복구한 친구', rooms: [] },
      });
    else held.push(route);
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: failureHeading }),
  ).toBeVisible();
  await page.getByRole('button', { name: '다시 연결하기' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '복구한 친구님',
  );
  await page.clock.runFor(4000);
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    }),
  );
  await page.clock.runFor(31_000);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '복구한 친구님',
  );
  await held[0].fulfill({
    json: { user: 'my-id', nickname: '늦게 갱신한 친구', rooms: [] },
  });
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '늦게 갱신한 친구님',
  );
  expect(gets).toBe(3);
});
