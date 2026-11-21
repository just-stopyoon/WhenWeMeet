import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/fixtures';
import { proxy } from '../../api/gateway.js';

const upstreamOrigin = 'https://when-we-meet-yangpa.stopjung1025.chatgpt.site';
const gatewayOrigin = 'https://when-we-meet.example';
const webAppPaths = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
] as const;

type Rewrite = { source: string; destination: string };

async function rewrites(): Promise<Rewrite[]> {
  const config = JSON.parse(await readFile('vercel.json', 'utf8')) as {
    rewrites: Rewrite[];
  };
  return config.rewrites;
}

// Replaces the global fetch so proxy() never reaches the network.
async function withUpstream<T>(
  run: (calls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.href);
    const type = url.pathname.endsWith('.webmanifest')
      ? 'application/manifest+json'
      : 'image/png';
    return new Response(`upstream ${url.pathname}`, {
      status: 200,
      headers: { 'content-type': type },
    });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('vercel.json은 앱 정보·아이콘 경로를 정확한 게이트웨이 경로로 넘긴다', async () => {
  const all = await rewrites();
  for (const path of webAppPaths) {
    expect(
      all.filter((rewrite) => rewrite.source === path),
      path,
    ).toEqual([{ source: path, destination: `/api/gateway?path=${path}` }]);
  }
});

test('게이트웨이는 앱 정보·아이콘 경로를 고정 원본에 no-store로 넘기고 POST를 막는다', async () => {
  const all = await rewrites();
  for (const path of webAppPaths) {
    const rewrite = all.find((candidate) => candidate.source === path);
    expect(rewrite, `${path} rewrite is missing.`).toBeTruthy();
    const url = new URL(rewrite!.destination, gatewayOrigin).href;
    await withUpstream(async (calls) => {
      const response = await proxy(new Request(url));
      expect(response.status, path).toBe(200);
      expect(calls).toEqual([upstreamOrigin + path]);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await response.text();
      expect(body).toBe(`upstream ${path}`);
      expect(body).not.toContain('when-meet-analytics');
      expect(body).not.toContain('googletagmanager');

      const post = await proxy(
        new Request(url, {
          method: 'POST',
          headers: { origin: gatewayOrigin },
          body: '{}',
        }),
      );
      expect(post.status, `${path} POST`).toBe(403);
      expect(calls).toHaveLength(1);
    });
  }
});

test('게이트웨이는 비슷하지만 허용하지 않은 경로를 404로 막는다', async () => {
  for (const path of [
    '/icons/icon-193.png',
    '/icons/',
    '/icons',
    '/manifest.json',
    '/icons/icon-192.png.bak',
    '/icons/icon-192.png/extra',
    '/manifest.webmanifest.map',
  ]) {
    await withUpstream(async (calls) => {
      const response = await proxy(
        new Request(`${gatewayOrigin}/api/gateway?path=${path}`),
      );
      expect(response.status, path).toBe(404);
      expect(calls, path).toEqual([]);
    });
  }
});

// The service worker gets its own fake origin that answers as JavaScript,
// leaving the existing upstream above unchanged (issue #14 T4).
async function withScriptUpstream<T>(
  run: (calls: { url: string; method: string }[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url: url.href, method: init?.method ?? 'GET' });
    return new Response(`// upstream ${url.pathname}`, {
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('vercel.json은 /sw.js를 정확한 게이트웨이 경로 하나로 넘긴다', async () => {
  const all = await rewrites();
  expect(all.filter((rewrite) => rewrite.source === '/sw.js')).toEqual([
    { source: '/sw.js', destination: '/api/gateway?path=/sw.js' },
  ]);
});

test('게이트웨이는 /sw.js GET·HEAD를 고정 원본에 JavaScript 그대로 no-store로 넘긴다', async () => {
  const rewrite = (await rewrites()).find(
    (candidate) => candidate.source === '/sw.js',
  );
  expect(rewrite, '/sw.js rewrite is missing.').toBeTruthy();
  const url = new URL(rewrite!.destination, gatewayOrigin).href;
  for (const method of ['GET', 'HEAD'] as const) {
    await withScriptUpstream(async (calls) => {
      const response = await proxy(new Request(url, { method }));
      expect(response.status, method).toBe(200);
      expect(calls, method).toEqual([
        { url: upstreamOrigin + '/sw.js', method },
      ]);
      expect(response.headers.get('content-type'), method).toBe(
        'text/javascript; charset=utf-8',
      );
      expect(response.headers.get('cache-control'), method).toBe(
        'private, no-store',
      );
      expect(response.headers.get('x-content-type-options'), method).toBe(
        'nosniff',
      );
      const body = await response.text();
      expect(body, method).toBe(method === 'HEAD' ? '' : '// upstream /sw.js');
      expect(body).not.toContain('when-meet-analytics');
      expect(body).not.toContain('googletagmanager');
    });
  }
});

test('게이트웨이는 정규화하면 /sw.js인 경로를 같은 자원으로 넘긴다', async () => {
  await withScriptUpstream(async (calls) => {
    const response = await proxy(
      new Request(`${gatewayOrigin}/api/gateway?path=/assets/../sw.js`),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ url: upstreamOrigin + '/sw.js', method: 'GET' }]);
  });
});

test('게이트웨이는 /sw.js POST를 403, PUT을 405로 막고 원본을 부르지 않는다', async () => {
  const url = `${gatewayOrigin}/api/gateway?path=/sw.js`;
  await withScriptUpstream(async (calls) => {
    const post = await proxy(
      new Request(url, {
        method: 'POST',
        headers: { origin: gatewayOrigin },
        body: '{}',
      }),
    );
    expect(post.status).toBe(403);
    const put = await proxy(new Request(url, { method: 'PUT', body: '{}' }));
    expect(put.status).toBe(405);
    expect(calls).toEqual([]);
  });
});

test('게이트웨이는 /sw.js와 비슷한 경로를 404로 막는다', async () => {
  for (const path of ['/sw.js.map', '/sw.jsx', '/sw', '/sw.js/']) {
    await withScriptUpstream(async (calls) => {
      const response = await proxy(
        new Request(`${gatewayOrigin}/api/gateway?path=${path}`),
      );
      expect(response.status, path).toBe(404);
      expect(calls, path).toEqual([]);
    });
  }
});
