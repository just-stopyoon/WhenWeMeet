import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  getRoom,
  postAction,
  test,
  uniqueTitle,
  type Room,
} from '../support/fixtures';

// /?room= entry from a notification click (issue #14 T4, decision S3). Real
// API/D1 only: the member check is the server's room list.
const goneToast = '종료되었거나 더 이상 참여 중인 모임이 아니에요.';

async function expectRoomOpened(page: Page, room: Room) {
  await expect(page.locator('header b')).toHaveText(room.title);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
}

async function expectHomeWithToast(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '우리 언제 만날까요?',
  );
  await expect(page.locator('.toast')).toHaveText(goneToast);
  await expect(page).toHaveURL(/\/$/);
}

test('/?room= 진입은 내 모임이면 그 모임을 열고 URL을 정리한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('알림 진입 멤버') });
    await context.addCookies(host.storageState.cookies);
    await page.goto(`/?room=${room.id}`);
    await expectRoomOpened(page, room);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('/?room= 진입은 나간·종료된·없는 모임이면 홈과 기존 토스트를 보인다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let left: Room | undefined;
  let closed: Room | undefined;
  try {
    left = await createRoom(host, { title: uniqueTitle('알림 진입 나감') });
    await action(guest, { type: 'join', code: left.code });
    const leave = await postAction(guest, {
      type: 'remove',
      roomId: left.id,
      member: guest.name,
    });
    expect(leave.status()).toBe(200);
    closed = await createRoom(host, { title: uniqueTitle('알림 진입 종료') });
    await action(guest, { type: 'join', code: closed.code });
    await action(host, { type: 'close', roomId: closed.id });
    expect((await getRoom(host, left.id)).members).toEqual([host.name]);

    await context.addCookies(guest.storageState.cookies);
    for (const id of [left.id, closed.id, `missing-${randomUUID()}`]) {
      await page.goto(`/?room=${encodeURIComponent(id)}`);
      await expectHomeWithToast(page);
      await expect(page.locator('header b')).toHaveText('언제 만날래');
    }
  } finally {
    if (left) await action(host, { type: 'close', roomId: left.id });
  }
});

test('로그인 전 /?room= 진입은 첫 조회 실패·재시도 동안 보관했다가 로그인 뒤 그 모임을 연다', async ({
  page,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  let initialFailed = false;
  try {
    room = await createRoom(host, { title: uniqueTitle('알림 진입 로그인') });
    await page.route('**/api/meeting', async (route) => {
      if (route.request().method() === 'GET' && !initialFailed) {
        initialFailed = true;
        await route.fulfill({ status: 503, json: { error: '첫 조회만 실패' } });
      } else await route.continue();
    });
    await page.goto(`/?room=${room.id}`);
    await page
      .getByRole('button', { name: '다시 연결하기', exact: true })
      .click();
    await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('room')).toBe(room.id);
    await page.getByLabel('아이디', { exact: true }).fill(host.name);
    await page
      .getByLabel('숫자 4자리 비밀번호', { exact: true })
      .fill(host.pin);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expectRoomOpened(page, room);
    expect(initialFailed).toBe(true);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('로그인 전 /?room= 진입 뒤 그 모임에 없는 계정으로 회원가입하면 홈과 토스트를 보인다', async ({
  page,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('알림 진입 가입') });
    await page.goto(`/?room=${room.id}`);
    await page.getByRole('button', { name: '처음이에요 · 회원가입' }).click();
    await page
      .getByPlaceholder('친구들이 알아볼 수 있는 이름')
      .fill('알림 진입');
    await page
      .getByLabel('아이디', { exact: true })
      .fill(`entry${randomUUID().replaceAll('-', '').slice(0, 10)}`);
    await page.getByLabel('숫자 4자리 비밀번호', { exact: true }).fill('0123');
    await page.getByRole('button', { name: '회원가입', exact: true }).click();
    await expectHomeWithToast(page);
  } finally {
    if (room) await action(host, { type: 'close', roomId: room.id });
  }
});

test('/?join=과 /?room=이 함께 있으면 참가 화면이 우선이다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let invited: Room | undefined;
  let member: Room | undefined;
  try {
    invited = await createRoom(host, { title: uniqueTitle('알림 진입 초대') });
    member = await createRoom(guest, { title: uniqueTitle('알림 진입 내 방') });
    await context.addCookies(guest.storageState.cookies);
    await page.goto(`/?join=${invited.code}&room=${member.id}`);
    await expect(page.getByLabel('초대 코드', { exact: true })).toHaveValue(
      invited.code,
    );
    await expect(page.locator('header b')).toHaveText('모임 참가');
    await expect(page.locator('.toast')).toHaveCount(0);
  } finally {
    if (invited) await action(host, { type: 'close', roomId: invited.id });
    if (member) await action(guest, { type: 'close', roomId: member.id });
  }
});
