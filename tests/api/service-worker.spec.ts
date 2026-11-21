import { test, expect } from '../support/fixtures';

// The gateway adds nosniff, so the origin itself must label the worker as
// JavaScript (issue #14 T4).
test('테스트 서버의 /sw.js는 200이고 JavaScript로 응답한다', async ({
  request,
}) => {
  const response = await request.get('/sw.js');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    /^(text|application)\/javascript(;|$)/,
  );
  const body = await response.text();
  expect(body).toContain("addEventListener('push'");
  expect(body).toContain("addEventListener('notificationclick'");
});
