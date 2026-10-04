import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { labelDate } from '../../lib/meeting';
import {
  action,
  addDays,
  createRoom,
  expect,
  getRoom,
  postAction,
  prepareRoom,
  test,
  today,
  uniqueTitle,
  type Room,
  type TestAccount,
} from '../support/fixtures';

type Viewport = { width: number; height: number } | null;
type UiResult = { room?: Room; user?: string; error?: string };

async function actor(
  browser: Browser,
  contexts: BrowserContext[],
  baseURL: string | undefined,
  viewport: Viewport,
  account?: TestAccount,
) {
  const context = await browser.newContext({
    baseURL,
    viewport,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    storageState: account?.storageState,
  });
  contexts.push(context);
  return context.newPage();
}

async function enterRoom(page: Page, room: Room) {
  await page.bringToFront();
  const card = page.getByRole('button').filter({
    has: page.getByRole('heading', { name: room.title, exact: true }),
  });
  await card.click();
}

async function openRoom(page: Page, room: Room) {
  await page.goto('/');
  await enterRoom(page, room);
}

async function uiAction(
  page: Page,
  type: string,
  click: () => Promise<unknown>,
): Promise<UiResult> {
  const pendingResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === '/api/meeting' &&
      request.method() === 'POST' &&
      (request.postDataJSON() as { type?: string }).type === type
    );
  });
  await click();
  const response = await pendingResponse;
  expect(response.status(), `${type} UI request failed.`).toBe(200);
  const result = (await response.json()) as UiResult;
  expect(result.error).toBeUndefined();
  return result;
}

async function confirmDialog(
  page: Page,
  accept: boolean,
  click: () => Promise<unknown>,
) {
  const pendingDialog = page.waitForEvent('dialog');
  const clicking = click();
  const dialog = await pendingDialog;
  expect(dialog.type()).toBe('confirm');
  if (accept) await dialog.accept();
  else await dialog.dismiss();
  await clicking;
}

async function noOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    content: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
    viewport: window.innerWidth,
  }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
}

async function usablePrimary(button: Locator) {
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).toBeInViewport();
  await button.click({ trial: true });
}

async function cleanup(
  contexts: BrowserContext[],
  host: TestAccount,
  room?: Room,
) {
  await Promise.all(contexts.map((context) => context.close()));
  if (room)
    await postAction(host, { type: 'close', roomId: room.id }).catch(
      () => undefined,
    );
}

test('로그인과 초대 참가부터 일정·지역 확정, 새로고침까지 저장된다', async ({
  browser,
  baseURL,
  viewport,
  accounts,
}) => {
  const [host, guest] = accounts;
  const contexts: BrowserContext[] = [];
  let room: Room | undefined;
  try {
    room = await createRoom(host, {
      title: uniqueTitle('초대와 약속 확정'),
      size: 2,
      start: addDays(today(), 1),
    });
    const hostPage = await actor(browser, contexts, baseURL, viewport, host);
    const guestPage = await actor(browser, contexts, baseURL, viewport);
    await guestPage.goto(`/?join=${room.code}`);
    await guestPage.getByLabel('닉네임', { exact: true }).fill(guest.name);
    await guestPage
      .getByLabel('숫자 4자리 PIN', { exact: true })
      .fill(guest.pin);
    await uiAction(guestPage, 'login', () =>
      guestPage.getByRole('button', { name: '시작하기', exact: true }).click(),
    );
    await expect(guestPage.getByLabel('초대 코드')).toHaveValue(room.code);
    await uiAction(guestPage, 'join', () =>
      guestPage.getByRole('button', { name: '모임 참가하기' }).click(),
    );
    await guestPage.getByRole('button', { name: '점심', exact: true }).click();
    await uiAction(guestPage, 'schedule', () =>
      guestPage.getByRole('button', { name: '이 일정으로 제출하기' }).click(),
    );

    await openRoom(hostPage, room);
    await hostPage.getByRole('button', { name: '점심', exact: true }).click();
    await uiAction(hostPage, 'schedule', () =>
      hostPage.getByRole('button', { name: '이 일정으로 제출하기' }).click(),
    );
    await uiAction(hostPage, 'date', () =>
      hostPage.getByRole('button', { name: '점심 확정', exact: true }).click(),
    );
    await hostPage.getByRole('button', { name: '다른 지역 추가하기' }).click();
    await hostPage.getByLabel('지역 이름', { exact: true }).fill('__proto__');
    await uiAction(hostPage, 'region', () =>
      hostPage.getByRole('button', { name: '후보 추가하기' }).click(),
    );
    await hostPage
      .getByRole('button', { name: '__proto__', exact: true })
      .click();
    await uiAction(hostPage, 'vote', () =>
      hostPage.getByRole('button', { name: '이 지역으로 투표하기' }).click(),
    );
    await guestPage.bringToFront();
    await expect(
      guestPage.getByRole('button', { name: '__proto__', exact: true }),
    ).toBeVisible();
    await guestPage
      .getByRole('button', { name: '__proto__', exact: true })
      .click();
    await uiAction(guestPage, 'vote', () =>
      guestPage.getByRole('button', { name: '이 지역으로 투표하기' }).click(),
    );
    await expect(
      guestPage.getByRole('heading', { name: '그날, 여기서 만나요!' }),
    ).toBeVisible();
    const saved = await getRoom(host, room.id);
    expect(saved.stage).toBe('final');
    expect(saved.region).toBe('__proto__');
    expect(saved.attendees).toEqual([host.name, guest.name]);
    expect(saved.date).toBe(`${room.start}|점심`);

    await guestPage.reload();
    await enterRoom(guestPage, room);
    await expect(
      guestPage.getByRole('heading', { name: '그날, 여기서 만나요!' }),
    ).toBeVisible();
    await expect(
      guestPage.getByText('__proto__', { exact: true }),
    ).toBeVisible();
    await noOverflow(guestPage);
  } finally {
    await cleanup(contexts, host, room);
  }
});

test('참석 인원 부족을 방장이 취소·승인 가능한 날짜 재선택으로 복구한다', async ({
  browser,
  baseURL,
  viewport,
  accounts,
}) => {
  const [host, guest] = accounts;
  const contexts: BrowserContext[] = [];
  let room: Room | undefined;
  try {
    room = await prepareRoom([host, guest], {
      title: uniqueTitle('참석 부족 복구'),
    });
    room = await action(host, {
      type: 'date',
      roomId: room.id,
      slot: `${room.start}|점심`,
      manual: true,
    });
    const hostPage = await actor(browser, contexts, baseURL, viewport, host);
    const guestPage = await actor(browser, contexts, baseURL, viewport, guest);
    await openRoom(hostPage, room);
    await openRoom(guestPage, room);
    await uiAction(hostPage, 'confirm', () =>
      hostPage
        .getByRole('button', { name: '갈 수 있어요', exact: true })
        .click(),
    );
    await uiAction(guestPage, 'confirm', () =>
      guestPage.getByRole('button', { name: '이번엔 어려워요' }).click(),
    );
    await hostPage.bringToFront();
    await expect(
      hostPage.getByText(/참석 가능한 친구가 2명보다 적어요/),
    ).toBeVisible();
    await expect(
      guestPage.getByRole('button', { name: '다른 날짜 선택하기' }),
    ).toHaveCount(0);
    const before = await getRoom(host, room.id);
    const reopen = hostPage.getByRole('button', { name: '다른 날짜 선택하기' });
    await confirmDialog(hostPage, false, () => reopen.click());
    const cancelled = await getRoom(host, room.id);
    expect(cancelled.stage).toBe('confirm');
    expect(cancelled.confirmations).toEqual(before.confirmations);
    expect(cancelled.regionRevision ?? 0).toBe(before.regionRevision ?? 0);
    await expect(reopen).toBeVisible();

    await uiAction(hostPage, 'reopenDate', () =>
      confirmDialog(hostPage, true, () => reopen.click()),
    );
    const reopened = await getRoom(host, room.id);
    expect(reopened.stage).toBe('date');
    expect(reopened.regionRevision).toBe((before.regionRevision ?? 0) + 1);
    expect(reopened.responses).toEqual(before.responses);
    expect(reopened.regions).toEqual(before.regions);
    expect(reopened.confirmations).toEqual({});
    expect(reopened.votes).toEqual({});
    expect(reopened.attendees).toEqual([]);
    expect(reopened.date).toBeUndefined();
    await guestPage.bringToFront();
    await expect(
      guestPage.getByText('방장이 최종 날짜를 선택하고 있어요.'),
    ).toBeVisible();
    await expect(
      guestPage.getByRole('button', { name: '갈 수 있어요', exact: true }),
    ).toHaveCount(0);
  } finally {
    await cleanup(contexts, host, room);
  }
});

test('다른 참여자의 변경에도 draft를 유지하고 결선에서 숨은 선택을 지운다', async ({
  browser,
  baseURL,
  viewport,
  accounts,
}) => {
  const [host, guest, other] = accounts;
  const contexts: BrowserContext[] = [];
  let room: Room | undefined;
  try {
    room = await prepareRoom(accounts, {
      title: uniqueTitle('결선 선택 복원'),
    });
    room = await action(host, {
      type: 'date',
      roomId: room.id,
      slot: `${room.start}|점심`,
    });
    for (const name of ['A', 'B', 'C'])
      room = await action(host, { type: 'region', roomId: room.id, name });
    const guestPage = await actor(browser, contexts, baseURL, viewport, guest);
    const hostPage = await actor(browser, contexts, baseURL, viewport, host);
    await openRoom(guestPage, room);
    const a = guestPage.getByRole('button', { name: 'A', exact: true });
    const b = guestPage.getByRole('button', { name: 'B', exact: true });
    const c = guestPage.getByRole('button', { name: 'C', exact: true });
    await a.click();
    await c.click();
    await action(other, { type: 'region', roomId: room.id, name: 'D' });
    await expect(
      guestPage.getByRole('button', { name: 'D', exact: true }),
    ).toBeVisible();
    await expect(a).toHaveAttribute('aria-pressed', 'true');
    await expect(c).toHaveAttribute('aria-pressed', 'true');
    await action(other, {
      type: 'vote',
      roomId: room.id,
      choices: ['B'],
      round: 1,
      regionRevision: 0,
    });
    await expect(guestPage.getByText(/1 \/ 3명 제출/)).toBeVisible();
    await expect(a).toHaveAttribute('aria-pressed', 'true');
    await expect(c).toHaveAttribute('aria-pressed', 'true');
    await uiAction(guestPage, 'vote', () =>
      guestPage.getByRole('button', { name: '이 지역으로 투표하기' }).click(),
    );
    await action(host, {
      type: 'vote',
      roomId: room.id,
      choices: ['A', 'B'],
      round: 1,
      regionRevision: 0,
    });
    await expect(
      guestPage.getByRole('heading', { name: /친구들의 마음이/ }),
    ).toBeVisible();
    await openRoom(hostPage, room);
    await uiAction(hostPage, 'runoff', () =>
      hostPage.getByRole('button', { name: '한 번 더 투표하기' }).click(),
    );
    await guestPage.bringToFront();
    await expect(
      guestPage.getByText('동률인 지역 중 한 곳을 골라 주세요.'),
    ).toBeVisible();
    await expect(a).toHaveAttribute('aria-pressed', 'false');
    await expect(b).toHaveAttribute('aria-pressed', 'false');
    await expect(c).toHaveCount(0);
    await expect(
      guestPage.getByRole('button', { name: '이 지역으로 투표하기' }),
    ).toBeDisabled();
    await b.click();
    await uiAction(guestPage, 'vote', () =>
      guestPage.getByRole('button', { name: '이 지역으로 투표하기' }).click(),
    );
    const saved = await getRoom(guest, room.id);
    expect(saved.round).toBe(2);
    expect(saved.votes[guest.name]).toEqual(['B']);
  } finally {
    await cleanup(contexts, host, room);
  }
});

test('지난 후보를 제외한 미래 7일을 먼저 보여주고 나머지 날짜를 펼친다', async ({
  browser,
  baseURL,
  viewport,
  accounts,
}) => {
  const [host, guest] = accounts;
  const contexts: BrowserContext[] = [];
  let room: Room | undefined;
  try {
    const serverToday = today();
    const browserToday = addDays(serverToday, 1);
    room = await prepareRoom([host, guest], {
      title: uniqueTitle('미래 날짜 더보기'),
      start: serverToday,
      end: addDays(serverToday, 13),
    });
    const page = await actor(browser, contexts, baseURL, viewport, host);
    await page.clock.setFixedTime(new Date(`${browserToday}T12:00:00+09:00`));
    await openRoom(page, room);
    const candidates = page.getByRole('button', { name: /가능한 친구 보기$/ });
    await expect(candidates).toHaveCount(7);
    await expect(
      page.getByRole('button', {
        name: `${labelDate(serverToday)} 가능한 친구 보기`,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: `${labelDate(browserToday)} 가능한 친구 보기`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: '날짜 더 보기' }).click();
    await expect(candidates).toHaveCount(13);
    await expect(
      page.getByRole('button', { name: '날짜 더 보기' }),
    ).toHaveCount(0);
    const manualDate = page.getByLabel('다른 날짜', { exact: true });
    await expect(manualDate).toHaveAttribute('min', browserToday);
    await manualDate.fill(serverToday);
    await expect(
      page.getByRole('button', { name: '점심으로 다시 확인' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '저녁으로 다시 확인' }),
    ).toBeDisabled();
    await manualDate.fill(browserToday);
    await expect(
      page.getByRole('button', { name: '점심으로 다시 확인' }),
    ).toBeEnabled();
    await noOverflow(page);
  } finally {
    await cleanup(contexts, host, room);
  }
});

test('모바일 폭에서 하단 제출과 dialog 닫기·Escape를 사용할 수 있다', async ({
  browser,
  baseURL,
  viewport,
  accounts,
}) => {
  const [host, guest] = accounts;
  const contexts: BrowserContext[] = [];
  let room: Room | undefined;
  try {
    room = await prepareRoom([host, guest], {
      title: uniqueTitle('모바일 모임 관리'),
    });
    room = await action(host, {
      type: 'date',
      roomId: room.id,
      slot: `${room.start}|점심`,
    });
    const page = await actor(browser, contexts, baseURL, viewport, host);
    await openRoom(page, room);
    await page.getByRole('button', { name: '홍대, 신촌', exact: true }).click();
    const submit = page.getByRole('button', { name: '이 지역으로 투표하기' });
    await usablePrimary(submit);
    await noOverflow(page);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '모임 관리', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '설정', exact: true }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    await usablePrimary(submit);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '설정', exact: true }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    await usablePrimary(submit);
    await noOverflow(page);
  } finally {
    await cleanup(contexts, host, room);
  }
});
