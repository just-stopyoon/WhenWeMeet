import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  throw new Error(
    'The isolated test runner requires macOS or Linux (WSL is supported).',
  );
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const host = '127.0.0.1';
const port = 4317;
const artifacts = join(root, 'test-artifacts');
await mkdir(artifacts, { recursive: true });
const log = createWriteStream(join(artifacts, 'server.log'), { flags: 'w' });
const abort = new AbortController();
let temporary;
let active;
let activeClosed;
let signalExitCode = 0;

function record(message) {
  log.write(`${message}\n`);
  console.log(message);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    signalExitCode = signal === 'SIGINT' ? 130 : 0;
    abort.abort(new Error(`Received ${signal}`));
  });
}

function aborted() {
  return new Promise((_, reject) => {
    if (abort.signal.aborted) reject(abort.signal.reason);
    else
      abort.signal.addEventListener(
        'abort',
        () => reject(abort.signal.reason),
        { once: true },
      );
  });
}

async function requireFreePort() {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen({ host, port, exclusive: true }, resolve);
    });
  } catch (error) {
    throw new Error(
      `Test port ${host}:${port} is unavailable. Existing servers are never reused.`,
      { cause: error },
    );
  } finally {
    if (probe.listening)
      await new Promise((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
  }
}

function launch(command, args, ipc = false) {
  abort.signal.throwIfAborted();
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      BROWSER: 'none',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_WRITE_LOGS: 'false',
      WRANGLER_LOG_PATH: join(temporary, 'logs'),
      WRANGLER_REGISTRY_PATH: join(temporary, 'registry'),
      MINIFLARE_REGISTRY_PATH: join(temporary, 'registry'),
    },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  active = child;
  activeClosed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on('data', (chunk) => log.write(chunk));
  child.stderr.on('data', (chunk) => log.write(chunk));
  return child;
}

async function stopChild() {
  if (!active?.pid) return;
  const child = active;
  const kill = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  kill('SIGTERM');
  const timer = new AbortController();
  const ended = await Promise.race([
    activeClosed.then(() => true),
    delay(8_000, false, { signal: timer.signal }).catch(() => true),
  ]);
  timer.abort();
  if (!ended) {
    kill('SIGKILL');
    await activeClosed;
  }
  active = undefined;
}

async function execute() {
  await requireFreePort();
  abort.signal.throwIfAborted();
  temporary = await mkdtemp(join(tmpdir(), 'whenwemeet-playwright-'));
  record(`Isolated D1 directory: ${temporary}`);
  record(
    'Building app once. Full build and Workers logs: test-artifacts/server.log',
  );
  launch('npm', ['run', 'build']);
  const built = await Promise.race([activeClosed, aborted()]);
  if (built.code !== 0)
    throw new Error(
      `App build failed (${built.code ?? built.signal}). See test-artifacts/server.log.`,
      { cause: built.error },
    );
  active = undefined;
  // Check again after the build so a newly occupied port cannot be reused.
  await requireFreePort();
  const child = launch(
    process.execPath,
    [
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      'dist/server/wrangler.json',
      '--local',
      '--ip',
      host,
      '--port',
      String(port),
      '--persist-to',
      join(temporary, 'state'),
      '--inspector-port',
      '0',
      '--show-interactive-dev-session=false',
    ],
    true,
  );
  const exited = activeClosed.then((result) => {
    throw new Error(
      `Test Wrangler exited (${result.code ?? result.signal}). See test-artifacts/server.log.`,
      { cause: result.error },
    );
  });
  const ready = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      try {
        const data =
          typeof message === 'string' ? JSON.parse(message) : message;
        if (data?.event !== 'DEV_SERVER_READY') return;
        if (data.ip !== host || data.port !== port)
          reject(new Error('Wrangler started at an unexpected address.'));
        else resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  await Promise.race([ready, exited, aborted()]);
  // Initialises the schema in this run's private D1 and verifies the actual API.
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    abort.signal.throwIfAborted();
    try {
      const response = await fetch(`http://${host}:${port}/api/meeting`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_000)]),
      });
      const data = await response.json();
      healthy =
        response.ok &&
        data.user === '' &&
        Array.isArray(data.rooms) &&
        data.rooms.length === 0;
    } catch {
      // The Workers proxy can be ready before the application's first request.
    }
    if (healthy) break;
    await Promise.race([
      delay(100, undefined, { signal: abort.signal }),
      exited,
    ]);
  }
  if (!healthy)
    throw new Error(
      'The isolated /api/meeting did not return the expected unauthenticated response.',
    );
  await writeFile(
    join(artifacts, 'server.json'),
    JSON.stringify({ pid: child.pid, temporary, host, port }, null, 2),
  );
  record('WHENWEMEET_TEST_SERVER_READY');
  await Promise.race([exited, aborted()]);
}

try {
  await execute();
} catch (error) {
  if (abort.signal.aborted) process.exitCode = signalExitCode;
  else {
    record(error.stack ?? String(error));
    process.exitCode = 1;
  }
} finally {
  await stopChild();
  if (temporary) {
    await rm(temporary, { recursive: true, force: true });
    record(`Removed isolated D1 directory: ${String(temporary)}`);
  }
  log.end();
  await once(log, 'finish');
}
