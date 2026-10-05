import type { MeetingResponse } from '../../lib/meeting-contract';
import {
  action,
  addDays,
  expect,
  getRoom,
  test,
  today,
  uniqueTitle,
  type MeetingRequest,
  type Room,
} from '../support/fixtures';

test('생성 화면을 나갔다 돌아와도 작성값을 유지하고 그 값으로 모임을 저장한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  const start = addDays(today(), 2);
  const payload = {
    type: 'create',
    title: uniqueTitle('생성 작성값 유지'),
    start,
    end: addDays(start, 8),
    size: 3,
    mode: 'most',
  } satisfies MeetingRequest;
  let room: Room | undefined;
  try {
    await context.addCookies(host.storageState.cookies);
    await page.goto('/');
    const openCreate = page.getByRole('button', {
      name: '새 모임 만들기',
      exact: true,
    });
    await openCreate.click();
    const name = page.getByLabel('모임 이름', { exact: true });
    const startInput = page.getByLabel('시작일', { exact: true });
    const endInput = page.getByLabel('종료일', { exact: true });
    const most = page.getByRole('button', {
      name: '가장 많이 모일 수 있는 날',
      exact: true,
    });
    await name.fill(payload.title);
    await startInput.fill(payload.start);
    await endInput.fill(payload.end);
    await expect(page.locator('.stepper strong')).toHaveText('5명');
    const decrease = page.getByRole('button', {
      name: '인원 줄이기',
      exact: true,
    });
    await decrease.click();
    await decrease.click();
    await most.click();

    await page
      .getByRole('button', { name: '내 모임으로', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '우리 언제 만날까요?',
    );
    await expect(name).toHaveCount(0);
    await openCreate.click();

    await expect(name).toHaveValue(payload.title);
    await expect(startInput).toHaveValue(payload.start);
    await expect(endInput).toHaveValue(payload.end);
    await expect(page.locator('.stepper strong')).toHaveText('3명');
    await expect(most).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('button', { name: '모두 가능한 날', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');

    const created = page.waitForResponse((response) => {
      const request = response.request();
      return (
        new URL(response.url()).pathname === '/api/meeting' &&
        request.method() === 'POST' &&
        (request.postDataJSON() as { type?: string }).type === 'create'
      );
    });
    await page
      .getByRole('button', { name: '모임 만들기', exact: true })
      .click();
    const response = await created;
    expect(response.request().postDataJSON()).toEqual(payload);
    expect(response.status()).toBe(200);
    const result = (await response.json()) as MeetingResponse<typeof payload>;
    room = result.room;
    expect(room).toBeTruthy();
    await expect(page.locator('.app-shell')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(
      page.getByRole('heading', { name: '우리, 언제 시간 돼요?', exact: true }),
    ).toBeVisible();
    await expect(page.locator('header')).toContainText(payload.title);

    const saved = await getRoom(host, room.id);
    expect(saved).toMatchObject({
      title: payload.title,
      start: payload.start,
      end: payload.end,
      size: payload.size,
      mode: payload.mode,
      host: host.name,
      members: [host.name],
      stage: 'schedule',
    });
    expect(saved).toEqual(room);
  } finally {
    if (room) {
      const closed = await action(host, { type: 'close', roomId: room.id });
      expect(closed.stage).toBe('closed');
    }
  }
});
