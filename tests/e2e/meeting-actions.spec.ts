import type { Page } from '@playwright/test';
import type { MeetingResponse } from '../../lib/meeting-contract';
import {
  action,
  createRoom,
  expect,
  getRoom,
  prepareRoom,
  test,
  uniqueTitle,
  type RoomRequest,
  type Room,
} from '../support/fixtures';

async function openRoom(page: Page, room: Room) {
  await page.goto('/');
  await page
    .getByRole('button')
    .filter({
      has: page.getByRole('heading', { name: room.title, exact: true }),
    })
    .click();
}

async function uiAction(
  page: Page,
  payload: RoomRequest,
  interact: () => Promise<unknown>,
) {
  const pending = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === '/api/meeting' &&
      request.method() === 'POST' &&
      (request.postDataJSON() as { type?: string }).type === payload.type
    );
  });
  await interact();
  const response = await pending;
  expect(response.request().postDataJSON()).toEqual(payload);
  expect(response.status()).toBe(200);
  const result = (await response.json()) as MeetingResponse<RoomRequest>;
  expect(result.room).toBeTruthy();
  return result.room!;
}

test('무작위 선정은 action만 보내고 서버가 응답한 지역을 표시·저장한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await prepareRoom([host, guest], {
      title: uniqueTitle('서버 지역 추첨'),
    });
    room = await action(host, {
      type: 'date',
      roomId: room.id,
      slot: `${room.start}|점심`,
    });
    const choices = room.regions.slice(0, 2);
    await action(host, {
      type: 'vote',
      roomId: room.id,
      choices: [choices[0]],
      round: room.round,
      regionRevision: room.regionRevision ?? 0,
    });
    room = await action(guest, {
      type: 'vote',
      roomId: room.id,
      choices: [choices[1]],
      round: room.round,
      regionRevision: room.regionRevision ?? 0,
    });
    expect(room.stage).toBe('tie');
    expect(room.tied).toEqual(choices);
    await context.addCookies(host.storageState.cookies);
    await openRoom(page, room);

    const result = await uiAction(
      page,
      { type: 'random', roomId: room.id },
      () => page.getByRole('button', { name: '무작위로 정하기' }).click(),
    );

    expect(result.stage).toBe('final');
    expect(choices).toContain(result.region);
    const chosen = result.region!;
    await expect(
      page.getByRole('heading', { name: '그날, 여기서 만나요!' }),
    ).toBeVisible();
    await expect(page.getByText(chosen, { exact: true })).toBeVisible();
    const saved = await getRoom(host, room.id);
    expect(saved.region).toBe(chosen);
    expect(saved.stage).toBe('final');
    await openRoom(page, saved);
    await expect(page.getByText(chosen, { exact: true })).toBeVisible();
  } finally {
    if (room) {
      const closed = await action(host, { type: 'close', roomId: room.id });
      expect(closed.stage).toBe('closed');
    }
  }
});

test('타인 강퇴는 대상 action을 저장하고 관리 시트와 남은 멤버를 유지한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest, other] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('관리 시트에서 강퇴') });
    await action(guest, { type: 'join', code: room.code });
    await action(other, { type: 'join', code: room.code });
    await action(guest, {
      type: 'schedule',
      roomId: room.id,
      slots: [`${room.start}|점심`],
    });
    room = await action(other, {
      type: 'schedule',
      roomId: room.id,
      slots: [`${room.start}|저녁`],
    });
    await context.addCookies(host.storageState.cookies);
    await openRoom(page, room);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '모임 관리', exact: true });
    const memberRow = sheet
      .locator('.member-row')
      .filter({ hasText: guest.name });
    const result = await uiAction(
      page,
      { type: 'remove', roomId: room.id, member: guest.name },
      async () => {
        const pending = page.waitForEvent('dialog');
        const clicking = memberRow
          .getByRole('button', { name: '내보내기' })
          .click();
        const confirmation = await pending;
        expect(confirmation.type()).toBe('confirm');
        expect(confirmation.message()).toContain(guest.name);
        await confirmation.accept();
        await clicking;
      },
    );

    expect(result.members).toEqual([host.name, other.name]);
    await expect(sheet).toBeVisible();
    await expect(memberRow).toHaveCount(0);
    await expect(sheet.getByText(other.name, { exact: true })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    // Immediate focus after removing the focused row is a pre-existing issue
    // recorded in VALIDATION.md. The still-open sheet must remain operable.
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        sheet.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    const saved = await getRoom(host, room.id);
    expect(saved.members).toEqual([host.name, other.name]);
    expect(saved.responses[guest.name]).toBeUndefined();
    expect(saved.responses[other.name]).toEqual([`${room.start}|저녁`]);
    expect(saved.size).toBe(3);
  } finally {
    if (room) {
      const closed = await action(host, { type: 'close', roomId: room.id });
      expect(closed.stage).toBe('closed');
    }
  }
});
