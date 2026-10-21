import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  action,
  createRoom,
  expect,
  getRoom,
  test,
  uniqueTitle,
  type Room,
} from '../support/fixtures';

for (const mode of ['session', 'login', 'signup'] as const) {
  test(`초기 조회 재시도와 ${mode} 인증 뒤 원래 초대로 참가하고 D1에 저장한다`, async ({
    page,
    context,
    accounts,
  }, info) => {
    const [host, guest] = accounts;
    const newId = `retry${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const memberId = mode === 'signup' ? newId : guest.name;
    let room: Room | undefined;
    let initialFailed = false;
    let joinFailed = false;
    try {
      room = await createRoom(host, {
        title: uniqueTitle('연결 복구 초대'),
        size: 2,
      });
      if (mode === 'session')
        await context.addCookies(guest.storageState.cookies);
      await page.route('**/api/meeting', async (route) => {
        const request = route.request();
        if (request.method() === 'GET' && !initialFailed) {
          initialFailed = true;
          await route.fulfill({
            status: 503,
            json: { error: '첫 조회만 실패' },
          });
        } else if (
          mode === 'session' &&
          request.method() === 'POST' &&
          (request.postDataJSON() as { type: string }).type === 'join' &&
          !joinFailed
        ) {
          joinFailed = true;
          await route.fulfill({
            status: 503,
            json: { error: '참가를 다시 시도해 주세요.' },
          });
        } else await route.continue();
      });
      await page.goto(`/?join=${room.code.toLowerCase()}`);
      await expect(
        page.getByRole('heading', {
          name: '서버에 연결하지 못했어요',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByLabel('아이디', { exact: true })).toHaveCount(0);
      await page
        .getByRole('button', { name: '다시 연결하기', exact: true })
        .click();
      if (mode !== 'session') {
        await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
        if (mode === 'signup') {
          await page
            .getByRole('button', { name: '처음이에요 · 회원가입' })
            .click();
          await page
            .getByPlaceholder('친구들이 알아볼 수 있는 이름')
            .fill('초대받은 친구');
        }
        await page.getByLabel('아이디', { exact: true }).fill(memberId);
        await page
          .getByLabel('숫자 4자리 비밀번호', { exact: true })
          .fill(mode === 'signup' ? '0123' : guest.pin);
        const signedIn = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            (response.request().postDataJSON() as { type: string }).type ===
              mode,
        );
        await page
          .getByRole('button', {
            name: mode === 'signup' ? '회원가입' : '로그인',
            exact: true,
          })
          .click();
        expect((await signedIn).status()).toBe(200);
      }
      const code = page.getByLabel('초대 코드', { exact: true });
      await expect(code).toHaveValue(room.code);
      expect((await getRoom(host, room.id)).members).toEqual([host.name]);
      if (mode === 'session') {
        const directory = 'outputs/verification/initial-connection-retry';
        await mkdir(directory, { recursive: true });
        const path = join(
          directory,
          `${info.project.name}-invite-preserved.png`,
        );
        await page.screenshot({ path, fullPage: true, animations: 'disabled' });
        await info.attach('invite-preserved', {
          path,
          contentType: 'image/png',
        });
        const originalUrl = page.url();
        await page
          .getByRole('button', { name: '모임 참가하기', exact: true })
          .click();
        await expect(
          page
            .getByRole('main')
            .getByText('참가를 다시 시도해 주세요.', { exact: true }),
        ).toBeVisible();
        await expect(code).toHaveValue(room.code);
        expect(page.url()).toBe(originalUrl);
        expect((await getRoom(host, room.id)).members).toEqual([host.name]);
      }
      const joined = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          (response.request().postDataJSON() as { type: string }).type ===
            'join',
      );
      await page
        .getByRole('button', { name: '모임 참가하기', exact: true })
        .click();
      const response = await joined;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toEqual({
        type: 'join',
        code: room.code,
      });
      await expect(
        page.getByRole('heading', {
          name: '우리, 언제 시간 돼요?',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
      expect((await getRoom(host, room.id)).members).toEqual([
        host.name,
        memberId,
      ]);
      const sizes = await page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: room.title, exact: true }),
      ).toBeVisible();
    } finally {
      if (room) await action(host, { type: 'close', roomId: room.id });
    }
  });
}
