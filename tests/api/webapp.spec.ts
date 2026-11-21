import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';

type Tag = Record<string, string>;
type ManifestIcon = {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
};
type Head = { link: Tag[]; meta: Tag[] };

// The fixed public URL for each manifest icon purpose and size (issue #11).
const expectedIcons: Record<string, string> = {
  'any 192x192': '/icons/icon-192.png',
  'any 512x512': '/icons/icon-512.png',
  'maskable 512x512': '/icons/icon-maskable-512.png',
};

// Parses the served HTML with the browser's HTML parser and reads the real
// <head> elements, so comments and quoting follow browser behavior.
async function headTags(page: Page, html: string): Promise<Head> {
  return page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const read = (name: string) =>
      [...doc.head.querySelectorAll(name)].map((element) =>
        Object.fromEntries(
          [...element.attributes].map((attribute) => [
            attribute.name,
            attribute.value,
          ]),
        ),
      );
    return { link: read('link'), meta: read('meta') };
  }, html);
}

function single(tags: Tag[], key: string, value: string): Tag {
  const found = tags.filter((tag) => tag[key] === value);
  expect(found, `Expected one tag with ${key}="${value}".`).toHaveLength(1);
  return found[0];
}

// Width and height from the PNG signature and IHDR chunk.
function pngSize(body: Buffer) {
  expect(body.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(body.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return `${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`;
}

async function fetchPng(request: APIRequestContext, url: URL) {
  const response = await request.get(url.href);
  expect(response.status(), `${url.pathname} status`).toBe(200);
  expect(response.headers()['content-type'], url.pathname).toMatch(
    /^image\/png(;|$)/,
  );
  return pngSize(await response.body());
}

test('홈 화면 앱 메타·앱 정보·아이콘이 HTML과 응답에서 일치한다', async ({
  request,
  baseURL,
  page,
}) => {
  const documentUrl = new URL('/', baseURL);
  const documentResponse = await request.get(documentUrl.href);
  expect(documentResponse.status()).toBe(200);
  const html = await documentResponse.text();
  const { meta: metas, link: links } = await headTags(page, html);

  expect(single(metas, 'name', 'theme-color').content).toBe('#ffffff');
  const viewport = single(metas, 'name', 'viewport')
    .content.split(',')
    .map((part) => part.trim().replaceAll(' ', ''));
  expect(viewport).toContain('width=device-width');
  expect(viewport).toContain('viewport-fit=cover');

  const manifestUrl = new URL(
    single(links, 'rel', 'manifest').href,
    documentUrl,
  );
  expect(manifestUrl.href).toBe(
    new URL('/manifest.webmanifest', documentUrl).href,
  );
  const manifestResponse = await request.get(manifestUrl.href);
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toMatch(
    /^application\/(manifest\+)?json(;|$)/,
  );
  const manifest = (await manifestResponse.json()) as Record<string, unknown>;
  expect(Object.keys(manifest).sort()).toEqual([
    'background_color',
    'description',
    'display',
    'icons',
    'lang',
    'name',
    'scope',
    'short_name',
    'start_url',
    'theme_color',
  ]);
  expect(manifest).toMatchObject({
    name: '언제 만날래',
    short_name: '언제 만날래',
    description: '친구들과 날짜와 지역을 정하고 가고 싶은 곳을 모아보세요.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#ffffff',
    background_color: '#ffffff',
    lang: 'ko',
  });
  expect(manifest).not.toHaveProperty('orientation');

  const icons = manifest.icons as ManifestIcon[];
  expect(Array.isArray(icons)).toBe(true);
  expect(
    icons.map((icon) => `${icon.purpose ?? 'any'} ${icon.sizes}`).sort(),
  ).toEqual(Object.keys(expectedIcons).sort());
  for (const icon of icons) {
    const key = `${icon.purpose ?? 'any'} ${icon.sizes}`;
    const url = new URL(icon.src, manifestUrl);
    expect(url.href, key).toBe(new URL(expectedIcons[key], documentUrl).href);
    expect(icon.type, key).toBe('image/png');
    const size = await fetchPng(request, url);
    expect(size, icon.src).toBe(icon.sizes);
  }

  const apple = new URL(
    single(links, 'rel', 'apple-touch-icon').href,
    documentUrl,
  );
  expect(apple.href).toBe(
    new URL('/icons/apple-touch-icon.png', documentUrl).href,
  );
  expect(await fetchPng(request, apple)).toBe('180x180');

  const tab = new URL(single(links, 'rel', 'icon').href, documentUrl);
  expect(tab.href).toBe(new URL('/app-logo.png', documentUrl).href);
  const tabResponse = await request.get(tab.href);
  expect(tabResponse.status()).toBe(200);
  expect(tabResponse.headers()['content-type']).toMatch(/^image\/png(;|$)/);
});
