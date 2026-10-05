import type { BrowserContext, Locator, Page } from '@playwright/test';
import {
  action,
  createRoom,
  expect,
  getRoom,
  listRooms,
  postAction,
  prepareRoom,
  test,
  uniqueTitle,
  type Room,
  type TestAccount,
} from '../support/fixtures';

async function signIn(context: BrowserContext, account: TestAccount) {
  await context.addCookies(account.storageState.cookies);
}

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
  type: string,
  interact: () => Promise<unknown>,
) {
  const pendingResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === '/api/meeting' &&
      request.method() === 'POST' &&
      (request.postDataJSON() as { type?: string }).type === type
    );
  });
  await interact();
  const response = await pendingResponse;
  expect(response.status(), `${type} UI request failed.`).toBe(200);
  const result = (await response.json()) as { error?: string };
  expect(result.error).toBeUndefined();
}

async function closeAndReturn(
  page: Page,
  opener: Locator,
  method: '닫기' | 'Escape',
) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  if (method === '닫기')
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  else await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await expect(opener).toBeFocused();
}

async function checkBothClosures(page: Page, opener: Locator, label: string) {
  for (const method of ['닫기', 'Escape'] as const) {
    await test.step(`${label} → ${method} → 원래 버튼`, async () => {
      if (method === 'Escape') await opener.press('Enter');
      else await opener.click();
      await closeAndReturn(page, opener, method);
    });
  }
}

async function nativeConfirmation(
  page: Page,
  accept: boolean,
  interact: () => Promise<unknown>,
) {
  const pendingDialog = page.waitForEvent('dialog');
  const interacting = interact();
  const dialog = await pendingDialog;
  expect(dialog.type()).toBe('confirm');
  if (accept) await dialog.accept();
  else await dialog.dismiss();
  await interacting;
}

async function expectHomeFocus(page: Page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('우리 언제 만날까요?');
  await expect(heading).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
}

async function cleanupRoom(account: TestAccount, room?: Room) {
  if (room)
    await postAction(account, { type: 'close', roomId: room.id }).catch(
      () => undefined,
    );
}

test('설정·참여 인원·가능한 친구 시트와 중첩 초대가 최초 버튼으로 돌아온다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, {
      title: uniqueTitle('일정 시트 포커스'),
      size: 3,
    });
    await action(guest, { type: 'join', code: room.code });
    await action(host, {
      type: 'schedule',
      roomId: room.id,
      slots: [`${room.start}|점심`],
    });
    await signIn(context, host);
    await openRoom(page, room);
    await page.getByRole('button', { name: '내 일정 수정하기' }).click();
    const settings = page.getByRole('button', { name: '설정', exact: true });
    const members = page.getByRole('button', {
      name: '참여 인원 보기',
      exact: true,
    });
    const attendees = page.getByRole('button', {
      name: '이 시간에 가능한 친구 보기',
    });
    await checkBothClosures(page, settings, '설정');
    await checkBothClosures(page, members, '참여 인원');
    await checkBothClosures(page, attendees, '가능한 친구');

    for (const source of [
      { opener: members, invite: '친구 초대하기', label: '참여 인원' },
      { opener: settings, invite: '친구 초대', label: '설정' },
    ]) {
      for (const method of ['닫기', 'Escape'] as const) {
        await test.step(`${source.label} → 초대 → ${method}`, async () => {
          await source.opener.click();
          await page
            .getByRole('dialog')
            .getByRole('button', {
              name: source.invite,
              exact: true,
            })
            .click();
          await expect(page.getByRole('dialog')).toHaveAccessibleName(
            '친구들과 함께 정해요',
          );
          await closeAndReturn(page, source.opener, method);
        });
      }
    }
  } finally {
    await cleanupRoom(host, room);
  }
});

test('지역·링크 시트는 닫기와 실제 저장 후 원래 추가 버튼을 다시 포커스한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await prepareRoom([host, guest], {
      title: uniqueTitle('추가 시트 포커스'),
    });
    room = await action(host, {
      type: 'date',
      roomId: room.id,
      slot: `${room.start}|점심`,
    });
    await signIn(context, host);
    await openRoom(page, room);
    const addRegion = page.getByRole('button', { name: '다른 지역 추가하기' });
    await checkBothClosures(page, addRegion, '지역 추가');
    await addRegion.click();
    await page
      .getByRole('dialog')
      .getByLabel('지역 이름', { exact: true })
      .fill('포커스 후보');
    await uiAction(page, 'region', () =>
      page
        .getByRole('dialog')
        .getByRole('button', { name: '후보 추가하기' })
        .click(),
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(addRegion).toBeFocused();
    expect((await getRoom(host, room.id)).regions).toContain('포커스 후보');

    await action(host, {
      type: 'vote',
      roomId: room.id,
      choices: ['포커스 후보'],
      round: 1,
      regionRevision: 0,
    });
    room = await action(guest, {
      type: 'vote',
      roomId: room.id,
      choices: ['포커스 후보'],
      round: 1,
      regionRevision: 0,
    });
    expect(room.stage).toBe('final');
    await openRoom(page, room);
    const addLink = page.getByRole('button', {
      name: '음식점 링크 추가',
      exact: true,
    });
    await checkBothClosures(page, addLink, '링크 추가');
    await addLink.click();
    const url = `https://example.com/places/${room.id}`;
    const linkDialog = page.getByRole('dialog');
    await linkDialog.getByLabel('링크', { exact: true }).fill(url);
    await linkDialog.getByLabel(/이름/).fill('포커스 장소');
    await uiAction(page, 'addLink', () =>
      linkDialog
        .getByRole('button', { name: '링크 추가하기', exact: true })
        .click(),
    );
    await expect(linkDialog).toHaveCount(0);
    await expect(addLink).toBeFocused();
    const saved = await getRoom(host, room.id);
    expect(saved.links).toEqual([
      expect.objectContaining({
        url,
        name: '포커스 장소',
        category: 'food',
        author: host.name,
      }),
    ]);
  } finally {
    await cleanupRoom(host, room);
  }
});

test('방장을 넘기고 관리 시트가 닫히면 같은 설정 버튼으로 돌아온다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  let cleanupHost = host;
  try {
    room = await createRoom(host, {
      title: uniqueTitle('방장 이전 포커스'),
      size: 2,
    });
    await action(guest, { type: 'join', code: room.code });
    await signIn(context, host);
    await openRoom(page, room);
    const settings = page.getByRole('button', { name: '설정', exact: true });
    await settings.click();
    await uiAction(page, 'transfer', () =>
      page
        .getByRole('dialog')
        .getByRole('button', { name: '방장 넘기기' })
        .click(),
    );
    cleanupHost = guest;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(settings).toBeFocused();
    expect((await getRoom(host, room.id)).host).toBe(guest.name);
  } finally {
    await cleanupRoom(cleanupHost, room);
  }
});

test('모임 종료 확인을 취소하면 시트를 유지하고 승인하면 홈 제목으로 이동한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, { title: uniqueTitle('모임 종료 포커스') });
    await signIn(context, host);
    await openRoom(page, room);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const sheet = page.getByRole('dialog');
    const close = sheet.getByRole('button', { name: '모임 조기 종료' });
    await nativeConfirmation(page, false, () => close.click());
    await expect(sheet).toBeVisible();
    await expect
      .poll(() =>
        sheet.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    expect((await getRoom(host, room.id)).stage).toBe('schedule');
    await uiAction(page, 'close', () =>
      nativeConfirmation(page, true, () => close.click()),
    );
    await expectHomeFocus(page);
    expect((await getRoom(host, room.id)).stage).toBe('closed');
  } finally {
    await cleanupRoom(host, room);
  }
});

test('모임 나가기 확인을 취소하면 시트를 유지하고 승인하면 홈 제목으로 이동한다', async ({
  page,
  context,
  accounts,
}) => {
  const [host, guest] = accounts;
  let room: Room | undefined;
  try {
    room = await createRoom(host, {
      title: uniqueTitle('모임 나가기 포커스'),
      size: 2,
    });
    await action(guest, { type: 'join', code: room.code });
    await signIn(context, guest);
    await openRoom(page, room);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const sheet = page.getByRole('dialog');
    const leave = sheet.getByRole('button', { name: '모임 나가기' });
    await nativeConfirmation(page, false, () => leave.click());
    await expect(sheet).toBeVisible();
    await expect
      .poll(() =>
        sheet.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    expect((await getRoom(host, room.id)).members).toContain(guest.name);
    await uiAction(page, 'remove', () =>
      nativeConfirmation(page, true, () => leave.click()),
    );
    await expectHomeFocus(page);
    expect((await getRoom(host, room.id)).members).not.toContain(guest.name);
    expect(
      (await listRooms(guest)).some((candidate) => candidate.id === room!.id),
    ).toBe(false);
  } finally {
    await cleanupRoom(host, room);
  }
});

test('별도 세션의 로그아웃은 로그인 제목으로 이동하고 공유 fixture 세션을 유지한다', async ({
  page,
  context,
  baseURL,
  accounts,
}) => {
  const [account] = accounts;
  if (!baseURL) throw new Error('Test baseURL is required.');
  const login = await context.request.post('/api/meeting', {
    headers: { Origin: new URL(baseURL).origin },
    data: { type: 'login', name: account.name, pin: account.pin },
  });
  expect(login.status()).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '우리 언제 만날까요?',
  );
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('내 계정');
  await uiAction(page, 'logout', () =>
    page
      .getByRole('dialog')
      .getByRole('button', { name: '다른 닉네임으로 들어가기' })
      .click(),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('반가워요!');
  await expect(heading).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  const loggedOut = await context.request.get('/api/meeting');
  expect(loggedOut.status()).toBe(200);
  expect(await loggedOut.json()).toMatchObject({ user: '', rooms: [] });
  await listRooms(account);
});
