import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = await mkdtemp(join(tmpdir(), 'whenwemeet-tests-'));
const run = (args) =>
  spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status ??
  1;

try {
  const tests = (await readdir(join(root, 'tests')))
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  if (!tests.length) throw new Error('No test files found.');
  const compilation = run([
    join(root, 'node_modules/typescript/bin/tsc'),
    '--module',
    'commonjs',
    '--moduleResolution',
    'node',
    '--target',
    'ES2022',
    '--strict',
    '--esModuleInterop',
    '--skipLibCheck',
    '--types',
    'node',
    '--rootDir',
    root,
    '--outDir',
    output,
    '--noEmitOnError',
    ...tests.map((name) => join(root, 'tests', name)),
  ]);
  if (compilation !== 0) {
    process.exitCode = compilation;
  } else {
    await writeFile(join(output, 'package.json'), '{"type":"commonjs"}\n');
    process.exitCode = run([
      '--test',
      ...tests.map((name) =>
        join(output, 'tests', name.replace(/\.ts$/, '.js')),
      ),
    ]);
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
