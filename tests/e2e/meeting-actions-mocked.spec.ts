import { expect, test, type Page } from '@playwright/test';
import type { MeetingRequest } from '../../lib/meeting-contract';
import type { Room } from '../../lib/meeting';

// Fixed snapshots and deliberate POST errors isolate input/focus recovery.
// Successful transitions and persistence use real Workers/D1 in the other suite.
const user = '방장';
const frozenTime = '2026-10-05T03:00:00+09:00';
const selectedDate = '2026-10-07';

function roomSnapshot(overrides: Partial<Room> = {}): Room {
  return {
    id: 'action-failure-room',
    code: 'FAILURE00001',
    title: '요청 실패 입력 보존',
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
    stage: 'date',
    regions: ['연남', '문래'],
    votes: {},
    round: 1,
    regionRevision: 2,
    attendees: [],
    links: [],
    emails: {},
    ...overrides,
  };
}

async function openWithError(page: Page, room: Room, message: string) {
  const posts: unknown[] = [];
  await page.clock.setFixedTime(new Date(frozenTime));
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { user, rooms: [room] } });
      return;
    }
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: message } });
  });
  await page.goto('/');
  await page
    .getByRole('button')
    .filter({
      has: page.getByRole('heading', { name: room.title, exact: true }),
    })
    .click();
  return posts;
}

async function expectRejectedAction(
  page: Page,
  payload: MeetingRequest,
  message: string,
  submit: () => Promise<unknown>,
) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/meeting' &&
      response.request().method() === 'POST',
  );
  await submit();
  const response = await pending;
  expect(response.request().postDataJSON()).toEqual(payload);
  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({ error: message });
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}

test('수동 날짜 POST가 실패하면 날짜 화면·입력·제출 포커스를 보존한다', async ({
  page,
}) => {
  const room = roomSnapshot();
  const message = '날짜 저장을 거절했어요. 다시 시도해 주세요.';
  const posts = await openWithError(page, room, message);
  const input = page.getByLabel('다른 날짜', { exact: true });
  await input.fill(selectedDate);
  const submit = page.getByRole('button', { name: '저녁으로 다시 확인' });
  const payload: MeetingRequest = {
    type: 'date',
    roomId: room.id,
    slot: `${selectedDate}|저녁`,
    manual: true,
  };
  await submit.focus();
  await expectRejectedAction(page, payload, message, () =>
    submit.press('Enter'),
  );

  expect(posts).toEqual([payload]);
  await expect(page.getByRole('status')).toHaveText(message);
  await expect(input).toHaveValue(selectedDate);
  await expect(submit).toBeEnabled();
  await expect(submit).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '함께할 수 있는 날을',
  );
  await expect(
    page.getByRole('heading', { name: '이날, 함께할 수 있나요?' }),
  ).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('링크 POST가 실패하면 카페 시트·두 입력·제출 포커스를 보존한다', async ({
  page,
}) => {
  const room = roomSnapshot({
    stage: 'final',
    date: '2026-10-06|점심',
    region: '연남',
    attendees: [user, '친구'],
  });
  const message = '링크 저장을 거절했어요. 다시 시도해 주세요.';
  const posts = await openWithError(page, room, message);
  await page.getByRole('button', { name: /^카페/ }).click();
  await page
    .getByRole('button', { name: '카페 링크 추가', exact: true })
    .click();
  const sheet = page.getByRole('dialog');
  const urlInput = sheet.getByLabel('링크', { exact: true });
  const nameInput = sheet.getByLabel(/이름/);
  const url = 'https://example.com/places/failure';
  const draftName = '  다시 찾을 카페  ';
  await urlInput.fill(url);
  await nameInput.fill(draftName);
  const submit = sheet.getByRole('button', {
    name: '링크 추가하기',
    exact: true,
  });
  const payload: MeetingRequest = {
    type: 'addLink',
    roomId: room.id,
    url,
    name: draftName.trim(),
    category: 'cafe',
  };
  await submit.focus();
  await expectRejectedAction(page, payload, message, () =>
    submit.press('Enter'),
  );

  expect(posts).toEqual([payload]);
  await expect(sheet.getByRole('alert')).toHaveText(message);
  await expect(sheet).toBeVisible();
  await expect(urlInput).toHaveValue(url);
  await expect(nameInput).toHaveValue(draftName);
  await expect(submit).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.keyboard.press('Shift+Tab');
  await expect(nameInput).toBeFocused();
});

test('링크 삭제 POST가 실패하면 기존 링크와 최종 화면을 유지한다', async ({
  page,
}) => {
  const link = {
    id: 'retained-link',
    url: 'https://example.com/places/retained',
    name: '보존할 음식점',
    category: 'food' as const,
    author: user,
  };
  const room = roomSnapshot({
    stage: 'final',
    date: '2026-10-06|점심',
    region: '연남',
    attendees: [user, '친구'],
    links: [link],
  });
  const message = '링크 삭제를 거절했어요. 다시 시도해 주세요.';
  const posts = await openWithError(page, room, message);
  const savedLink = page.getByRole('link', { name: /보존할 음식점/ });
  await expect(savedLink).toHaveAttribute('href', link.url);
  const remove = page.getByRole('button', { name: '링크 삭제', exact: true });
  const payload: MeetingRequest = {
    type: 'deleteLink',
    roomId: room.id,
    id: link.id,
  };
  await remove.focus();
  await expectRejectedAction(page, payload, message, () =>
    remove.press('Enter'),
  );

  expect(posts).toEqual([payload]);
  await expect(page.getByRole('status')).toHaveText(message);
  await expect(savedLink).toBeVisible();
  await expect(savedLink).toHaveAttribute('href', link.url);
  await expect(page.locator('.place-card')).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: '그날, 여기서 만나요!' }),
  ).toBeVisible();
  await expect(page.getByText('첫 번째 장소를 추천해 주세요')).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
