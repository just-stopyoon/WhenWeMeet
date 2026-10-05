import { expect, test } from '@playwright/test';
import { addDays, type Room } from '../../lib/meeting';
import type { MeetingSnapshot } from '../../lib/meeting-contract';

test('일정 수정은 최신 서버 응답으로 시작하고 작성 중인 선택은 폴링 후에도 유지한다', async ({
  page,
}) => {
  const user = '방장';
  const frozenTime = '2026-10-05T03:00:00.000Z';
  const start = '2026-10-06';
  const lunch = `${start}|점심`;
  const dinner = `${start}|저녁`;
  const initialRoom: Room = {
    id: 'schedule-draft-sync',
    code: 'DRAFT0000001',
    title: '일정 초안 동기화 모임',
    start,
    end: addDays(start, 13),
    size: 3,
    mode: 'all',
    host: user,
    members: [user, '친구', '다른 친구'],
    responses: { [user]: [lunch] },
    stage: 'schedule',
    regions: ['연남'],
    votes: {},
    round: 1,
    regionRevision: 0,
    attendees: [],
    links: [],
    emails: {},
  };
  // Explicit server snapshots and four-second clock advances exercise polling
  // without deriving expected state through the production reducer.
  const latestRoom: Room = {
    ...initialRoom,
    responses: { [user]: [dinner] },
  };
  const friendSubmittedRoom: Room = {
    ...latestRoom,
    responses: { [user]: [dinner], 친구: [lunch] },
  };
  let snapshot: MeetingSnapshot = { user, rooms: [initialRoom] };
  const posts: unknown[] = [];
  await page.clock.install({ time: new Date(Date.parse(frozenTime) - 1000) });
  await page.clock.pauseAt(new Date(frozenTime));
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 400,
        json: { error: '예상하지 않은 저장' },
      });
      return;
    }
    await route.fulfill({ json: snapshot });
  });
  await page.goto('/');
  await page
    .getByRole('button')
    .filter({
      has: page.getByRole('heading', {
        name: initialRoom.title,
        exact: true,
      }),
    })
    .click();
  await expect(
    page.getByRole('heading', { name: '친구들은 언제 가능할까요?' }),
  ).toBeVisible();
  const results = page.getByRole('region', {
    name: '선택한 날짜의 중간 결과',
  });
  await expect(
    results.getByRole('heading', { name: '점심 · 1명 가능' }),
  ).toBeVisible();
  await expect(
    results.getByRole('heading', { name: '저녁 · 0명 가능' }),
  ).toBeVisible();

  const latestPoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/meeting' &&
      response.request().method() === 'GET',
  );
  snapshot = { user, rooms: [latestRoom] };
  await page.clock.runFor(4000);
  const latestResponse = await latestPoll;
  expect(latestResponse.status()).toBe(200);
  expect(await latestResponse.json()).toEqual(snapshot);
  await expect(
    results.getByRole('heading', { name: '점심 · 0명 가능' }),
  ).toBeVisible();
  await expect(
    results.getByRole('heading', { name: '저녁 · 1명 가능' }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: '내 일정 수정하기', exact: true })
    .click();
  const lunchButton = page.getByRole('button', { name: '점심', exact: true });
  const dinnerButton = page.getByRole('button', { name: '저녁', exact: true });
  await expect(lunchButton).toHaveAttribute('aria-pressed', 'false');
  await expect(dinnerButton).toHaveAttribute('aria-pressed', 'true');
  await dinnerButton.click();
  await lunchButton.click();
  await expect(lunchButton).toHaveAttribute('aria-pressed', 'true');
  await expect(dinnerButton).toHaveAttribute('aria-pressed', 'false');

  const draftPoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/meeting' &&
      response.request().method() === 'GET',
  );
  snapshot = { user, rooms: [friendSubmittedRoom] };
  await page.clock.runFor(4000);
  const draftResponse = await draftPoll;
  expect(draftResponse.status()).toBe(200);
  expect(await draftResponse.json()).toEqual(snapshot);
  // The changed submission count proves React applied this GET before checking
  // that the unsaved lunch choice survived the server's saved dinner choice.
  await expect(
    page.getByRole('button', { name: '참여 인원 보기', exact: true }),
  ).toContainText('2명 제출');
  await expect(
    page.getByRole('heading', { name: '우리, 언제 시간 돼요?' }),
  ).toBeVisible();
  await expect(lunchButton).toHaveAttribute('aria-pressed', 'true');
  await expect(dinnerButton).toHaveAttribute('aria-pressed', 'false');
  expect(posts).toEqual([]);
});
