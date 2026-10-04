import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Room } from '../../lib/meeting';

// These explicit API snapshots exercise browser focus only. Real API/D1 tests
// cover transitions separately; no production reducer builds the mock responses.
const user = '방장';
const frozenTime = '2026-10-04T03:00:00.000Z';
const slots = ['2026-10-05|점심', '2026-10-06|저녁'];

function regionSnapshot(overrides: Partial<Room> = {}): Room {
  return {
    id: 'sheet-focus-room',
    code: 'FOCUS0000001',
    title: '시트 포커스 확인 모임',
    start: '2026-10-04',
    end: '2026-10-17',
    size: 2,
    mode: 'all',
    host: user,
    members: [user, '친구'],
    responses: { [user]: [...slots], 친구: [...slots] },
    stage: 'region',
    regions: ['연남', '문래'],
    votes: {},
    round: 1,
    regionRevision: 3,
    attendees: [user, '친구'],
    date: '2026-10-05|점심',
    confirmations: {},
    links: [],
    emails: {},
    ...overrides,
  };
}

type Snapshot = { user: string; rooms: Room[] };

async function mockSnapshots(page: Page, initial: Snapshot) {
  let snapshot = initial;
  const posts: unknown[] = [];
  await page.clock.install({ time: new Date(Date.parse(frozenTime) - 1000) });
  await page.clock.pauseAt(new Date(frozenTime));
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: snapshot });
      return;
    }
    posts.push(route.request().postDataJSON());
    await route.fulfill({
      status: 400,
      json: { error: '후보를 저장하지 못했어요. 다시 시도해 주세요.' },
    });
  });
  return {
    posts,
    async poll(next: Snapshot) {
      snapshot = next;
      const received = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/meeting') &&
          response.request().method() === 'GET',
      );
      await page.clock.runFor(4000);
      const response = await received;
      expect(response.status()).toBe(200);
      expect(await response.finished()).toBeNull();
      // Let any scheduled focus restoration run before asserting its result.
      await page.clock.runFor(32);
    },
  };
}

async function openRoom(page: Page, room: Room) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(room.title) }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function expectNativeTabTarget(
  page: Page,
  key: 'Tab' | 'Shift+Tab',
  target: Locator,
) {
  await page.keyboard.press(key);
  // A minimal native-dialog reproduction confirms Chromium can visit browser
  // chrome at this boundary. Permit that exact state once, never a background
  // page element, then require the expected control inside the modal dialog.
  const browserChrome = await page.evaluate(
    () => document.activeElement === document.body && !document.hasFocus(),
  );
  if (browserChrome) {
    await expect(page.locator('dialog:modal')).toHaveCount(1);
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

for (const kind of ['region', 'link'] as const) {
  test(`${kind} 시트는 입력에 포커스를 두고 네이티브 Tab 순서에서 배경 컨트롤을 건너뛴다`, async ({
    page,
  }) => {
    const room = regionSnapshot(
      kind === 'link' ? { stage: 'final', region: '연남' } : {},
    );
    await mockSnapshots(page, { user, rooms: [room] });
    await openRoom(page, room);
    const opener = page.getByRole('button', {
      name: kind === 'region' ? '다른 지역 추가하기' : '음식점 링크 추가',
      exact: true,
    });
    await opener.click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByLabel(kind === 'region' ? '지역 이름' : '링크', {
      exact: true,
    });
    await expect(input).toBeFocused();

    const close = dialog.getByRole('button', { name: '닫기', exact: true });
    const save = dialog.getByRole('button', {
      name: kind === 'region' ? '후보 추가하기' : '링크 추가하기',
      exact: true,
    });
    await save.focus();
    await expectNativeTabTarget(page, 'Tab', close);
    await expectNativeTabTarget(page, 'Shift+Tab', save);
    await page.keyboard.press('Shift+Tab');
    await expect(
      kind === 'region'
        ? input
        : dialog.getByPlaceholder('장소 이름을 적어 주세요'),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test('폴링에서 열린 모임이 사라지면 시트를 닫고 홈 제목에 포커스를 둔다', async ({
  page,
}) => {
  const room = regionSnapshot();
  const mock = await mockSnapshots(page, { user, rooms: [room] });
  await openRoom(page, room);
  // The settings button survives the view change, but belongs to another view.
  const settings = page.getByRole('button', { name: '설정', exact: true });
  await settings.click();
  await expect(page.getByRole('dialog', { name: '모임 관리' })).toBeVisible();

  await mock.poll({ user, rooms: [] });

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 1, name: /우리 언제 만날까요/ }),
  ).toBeFocused();
  await expect(settings).not.toBeFocused();
  await expect(
    page.getByRole('button', { name: new RegExp(room.title) }),
  ).toHaveCount(0);
});

for (const openerKind of ['settings', 'region'] as const) {
  test(`폴링으로 날짜 revision이 바뀌면 ${openerKind === 'settings' ? '남아 있는 시작 버튼' : '사라진 시작 버튼 대신 새 제목'}에 포커스를 복원한다`, async ({
    page,
  }) => {
    const room = regionSnapshot();
    const reopened = regionSnapshot({
      stage: 'date',
      date: undefined,
      attendees: [],
      regionRevision: 4,
    });
    const mock = await mockSnapshots(page, { user, rooms: [room] });
    await openRoom(page, room);
    const opener = page.getByRole('button', {
      name: openerKind === 'settings' ? '설정' : '다른 지역 추가하기',
      exact: true,
    });
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await mock.poll({ user, rooms: [reopened] });

    await expect(page.getByRole('dialog')).toHaveCount(0);
    const heading = page.getByRole('heading', {
      level: 1,
      name: /함께할 수 있는 날을/,
    });
    await expect(heading).toBeVisible();
    if (openerKind === 'settings') {
      await expect(opener).toBeFocused();
      await expect(heading).not.toBeFocused();
    } else {
      await expect(opener).toHaveCount(0);
      await expect(heading).toBeFocused();
    }
  });
}

test('홈에서 계정 시트가 열린 채 세션을 잃으면 로그인 제목에 포커스를 둔다', async ({
  page,
}) => {
  const mock = await mockSnapshots(page, { user, rooms: [] });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: /우리 언제 만날까요/ }),
  ).toBeVisible();
  const settings = page.getByRole('button', { name: '설정', exact: true });
  await settings.click();
  await expect(page.getByRole('dialog', { name: '내 계정' })).toBeVisible();

  await mock.poll({ user: '', rooms: [] });

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 1, name: /어떻게 불러드릴까요/ }),
  ).toBeFocused();
  await expect(page.getByLabel('닉네임', { exact: true })).toBeVisible();
  await expect(settings).not.toBeFocused();
});

test('일반 폴링은 열린 시트의 입력과 닫힌 뒤 사용자가 옮긴 포커스를 유지한다', async ({
  page,
}) => {
  const room = regionSnapshot();
  const voted = regionSnapshot({ votes: { 친구: ['연남'] } });
  const mock = await mockSnapshots(page, { user, rooms: [room] });
  await openRoom(page, room);
  await page
    .getByRole('button', { name: '다른 지역 추가하기', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('지역 이름', { exact: true });
  await input.fill('작성 중인 지역');

  await mock.poll({ user, rooms: [voted] });

  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('작성 중인 지역');
  await expect(input).toBeFocused();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/1 \/ 2명 제출/)).toBeVisible();
  const candidate = page.getByRole('button', { name: '문래', exact: true });
  await candidate.focus();

  await mock.poll({ user, rooms: [voted] });

  await expect(candidate).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).not.toBeFocused();
});

test('후보 저장이 실패하면 시트와 입력값을 보존하고 내부 제출 버튼의 포커스를 유지한다', async ({
  page,
}) => {
  const room = regionSnapshot();
  const mock = await mockSnapshots(page, { user, rooms: [room] });
  await openRoom(page, room);
  await page
    .getByRole('button', { name: '다른 지역 추가하기', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('지역 이름', { exact: true });
  await input.fill('여의도');
  const save = dialog.getByRole('button', {
    name: '후보 추가하기',
    exact: true,
  });
  await save.click();

  await expect(dialog.getByRole('alert')).toHaveText(
    '후보를 저장하지 못했어요. 다시 시도해 주세요.',
  );
  expect(mock.posts).toEqual([
    { type: 'region', name: '여의도', roomId: room.id },
  ]);
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('여의도');
  await expect(save).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
});

test('닫은 직후 다시 연 시트의 입력 포커스를 이전 닫기 작업이 빼앗지 않는다', async ({
  page,
}) => {
  const room = regionSnapshot();
  await mockSnapshots(page, { user, rooms: [room] });
  await openRoom(page, room);
  const opener = page.getByRole('button', {
    name: '다른 지역 추가하기',
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('지역 이름', { exact: true });
  await expect(input).toBeFocused();

  for (let cycle = 0; cycle < 3; cycle++) {
    // DOM clicks avoid Playwright's actionability animation frames, leaving any
    // stale timer/frame from the close pending until the next sheet is open.
    await dialog
      .getByRole('button', { name: '닫기', exact: true })
      .evaluate((button) => {
        if (!(button instanceof HTMLButtonElement))
          throw new Error('Expected a button.');
        button.click();
      });
    await expect(dialog).toHaveCount(0);
    await opener.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement))
        throw new Error('Expected a button.');
      button.click();
    });
    await expect(input).toBeFocused();
    await page.clock.runFor(100);
    await expect(input).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

for (const condition of ['disabled', 'hidden', 'removed'] as const) {
  test(`시트 시작 버튼이 ${condition} 상태이면 현재 화면 제목으로 포커스를 복원한다`, async ({
    page,
  }) => {
    const room = regionSnapshot();
    await mockSnapshots(page, { user, rooms: [room] });
    await openRoom(page, room);
    const opener = page.getByRole('button', {
      name: '다른 지역 추가하기',
      exact: true,
    });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('지역 이름', { exact: true })).toBeFocused();
    // Explicit DOM conditions isolate the restoration guard; they do not stand
    // in for server transitions (revision/removal cases above use GET snapshots).
    await opener.evaluate((button, state) => {
      if (!(button instanceof HTMLButtonElement))
        throw new Error('Expected a button.');
      if (state === 'disabled') button.disabled = true;
      else if (state === 'hidden') button.style.display = 'none';
      else button.remove();
    }, condition);
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('heading', { level: 1, name: '어디에서 만날까요?' }),
    ).toBeFocused();
  });
}
