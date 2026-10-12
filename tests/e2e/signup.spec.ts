import { expect, test } from '@playwright/test';

test('회원가입 항목과 로그인 항목을 구분하고 입력창 서체를 적용한다', async ({
  page,
}) => {
  const posts: unknown[] = [];
  await page.route('**/api/meeting', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { user: '', rooms: [] } });
    posts.push(route.request().postDataJSON());
    return route.fulfill({
      json: { user: 'my-id', nickname: '내 닉네임', rooms: [] },
    });
  });
  await page.goto('/');
  await expect(page.getByLabel('아이디', { exact: true })).toBeVisible();
  await expect(
    page.getByPlaceholder('친구들이 알아볼 수 있는 이름'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '처음이에요 · 회원가입' }).click();
  await page.getByLabel('아이디', { exact: true }).fill('my-id');
  await page.getByPlaceholder('친구들이 알아볼 수 있는 이름').fill('내 닉네임');
  await page.getByLabel('숫자 4자리 PIN', { exact: true }).fill('0123');
  const styles = await page
    .getByLabel('아이디', { exact: true })
    .evaluate((input) => ({
      value: getComputedStyle(input).fontWeight,
      placeholder: getComputedStyle(input, '::placeholder').fontWeight,
      line:
        parseFloat(getComputedStyle(input).lineHeight) /
        parseFloat(getComputedStyle(input).fontSize),
      spacing:
        parseFloat(getComputedStyle(input).letterSpacing) /
        parseFloat(getComputedStyle(input).fontSize),
      family: getComputedStyle(input).fontFamily,
    }));
  expect(styles.value).toBe('600');
  expect(styles.placeholder).toBe('500');
  expect(styles.line).toBeCloseTo(1.5);
  expect(styles.spacing).toBeCloseTo(-0.025);
  expect(styles.family).toContain('Pretendard');
  await expect(
    page.getByRole('img', { name: '언제 만날래', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '내 닉네임님',
  );
  expect(posts).toEqual([
    { type: 'signup', name: 'my-id', nickname: '내 닉네임', pin: '0123' },
  ]);
});
