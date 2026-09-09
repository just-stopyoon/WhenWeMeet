import { mkdir, writeFile } from 'node:fs/promises';

// Vercel hosts the gateway; the existing Sites deployment owns app builds and D1.
await mkdir('.vercel-static', { recursive: true });
await writeFile('.vercel-static/.gitkeep', '');
console.log('Vercel gateway ready. Existing Cloudflare app and database are retained.');
