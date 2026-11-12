import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, systemRandom, nodeFileSystem, nodeFileSystemSync, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { JournalThreadError, openRuntimeStore } from '@momonga/store';
import { createFakeClock, createFakeTimers, withTempDir, testKernelLock, afterMicrotasks, waitFor } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import * as clientModule from '../../src/memory/journal-thread-client.ts';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient, JournalThreadOptions } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_CODE } from '../../src/memory/journal-thread-code.generated.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

const runningWorkerCount = (): number => (process.report.getReport() as unknown as { workers: unknown[] }).workers.length;

const HANG_GUARD_MS = 60_000;

vi.setConfig({ testTimeout: HANG_GUARD_MS });

const GENEROUS_SILENCE_MS = 600_000;
const SILENCE_MS = 5_000;

type Fixture = { readonly databasePath: string; readonly identity: { dev: number; ino: number }; readonly dir: string; readonly marker: string };

const fixture = (context: TestContext): Fixture => {
  const dir = withTempDir(context);
  const databasePath = path.join(dir, 'runtime.db');
  openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), fileSystem: nodeFileSystem, fileSystemSync: nodeFileSystemSync, random: systemRandom, unaskedCommands: UNASKED_COMMANDS, path: databasePath, home: dir, clock: createFakeClock(0), leaseMs: 30_000, maxAttempts: 5, maxTotalAttempts: 50 }).close();
  const stat = fs.statSync(databasePath);
  return { databasePath, identity: { dev: stat.dev, ino: stat.ino }, dir, marker: path.join(dir, 'spawns') };
};

const fakeTimers = (): FakeTimers => createFakeTimers(createFakeClock(0));

const started = async (context: TestContext, options: JournalThreadOptions): Promise<JournalThreadClient> => {
  const client = await startJournalThread(options);
  context.onTestFinished(() => client.close());
  return client;
};

const spawnCountOf = (marker: string): number => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').length : 0);

const fakeThread = (marker: string, onMessage: string): string =>
  [
    "const fs = require('node:fs');",
    "const { parentPort, workerData, threadId } = require('node:worker_threads');",
    'const port = workerData.port;',
    `fs.appendFileSync(${JSON.stringify(marker)}, 'x');`,
    'const stat = fs.statSync(workerData.databasePath);',
    'port.postMessage({ ready: true, dev: stat.dev, ino: stat.ino });',
    `parentPort.on('message', (message) => { ${onMessage} });`,
  ].join('\n');

const PONG = 'port.postMessage({ id: message.id, ok: true, threadId });';

const turn = afterMicrotasks;

const until = (condition: () => boolean): Promise<void> => waitFor(condition, { description: 'the state of the journal thread the case names' });

const tracked = <T>(promise: Promise<T>): { readonly settled: () => boolean; readonly outcome: Promise<unknown> } => {
  let done = false;
  const outcome = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (error: unknown) => {
      done = true;
      return error;
    },
  );
  return { settled: () => done, outcome };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

const blockUntil = (cells: Int32Array, index: number, value: number): void => {
  while (Atomics.load(cells, index) !== value) Atomics.wait(cells, index, Atomics.load(cells, index));
};

const release = (cells: Int32Array, value: number): void => {
  Atomics.store(cells, 0, value);
  Atomics.notify(cells, 0);
};

const GATED_PROGRESS = [
  'const cells = new Int32Array(message.gate);',
  'for (let step = 1; step <= 2; step += 1) {',
  '  port.postMessage({ id: message.id, progress: step });',
  '  Atomics.store(cells, 1, step); Atomics.notify(cells, 1);',
  '  while (Atomics.load(cells, 0) < step) Atomics.wait(cells, 0, Atomics.load(cells, 0));',
  '}',
  'port.postMessage({ id: message.id, ok: true, steps: 2 });',
].join('\n');

const PROGRESS_ON_SIGNAL = [
  'const cells = new Int32Array(message.gate);',
  'while (Atomics.load(cells, 0) < 1) Atomics.wait(cells, 0, Atomics.load(cells, 0));',
  'port.postMessage({ id: message.id, progress: 1 });',
  'Atomics.store(cells, 1, 1); Atomics.notify(cells, 1);',
  'while (Atomics.load(cells, 0) < 2) Atomics.wait(cells, 0, Atomics.load(cells, 0));',
  'port.postMessage({ id: message.id, ok: true, steps: 1 });',
].join('\n');

describe('the one import path of JournalThreadError', () => {
  it('is defined by the store, and the client module does not export it', () => {
    expect(Object.keys(clientModule)).not.toContain('JournalThreadError');
    expect(new JournalThreadError('x').name).toBe('JournalThreadError');
  });
});

describe('journal thread start and handshake', () => {
  it('resolves start only after the embedded thread reports ready with the database identity', async (context) => {
    const { databasePath, identity } = fixture(context);
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS });
    expect(client.identity).toEqual(identity);
  });

  it('rejects start with JournalThreadError when the database lacks the events table the reader prepares its statements against', async (context) => {
    const { databasePath, identity } = fixture(context);
    const db = openDatabase(databasePath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    db.exec('ALTER TABLE events RENAME TO events_moved_away');
    db.close();

    const error = await rejectionOf(startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS }));

    expect(error).toBeInstanceOf(JournalThreadError);
    expect(String((error as Error).message) + String(((error as Error).cause as Error | undefined)?.message ?? '')).toMatch(/events/);
  });

  it('prepares the journal reader before it posts ready: the reader is created eagerly in the thread, never on the first request', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'memory', 'journal-thread.ts'), 'utf8');
    const serveBody = source.slice(source.indexOf('const serve = '));
    const created = serveBody.indexOf('createJournalReader(');
    const ready = serveBody.indexOf('ready: true');
    expect(created).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(created);
    expect(serveBody).not.toMatch(/\?\?=\s*createJournalReader/);
  });

  it('rejects start with JournalThreadError when the ready identity does not match the store file', async (context) => {
    const { databasePath, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity: { dev: identity.dev, ino: identity.ino + 1 }, silenceLimitMs: GENEROUS_SILENCE_MS }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the thread cannot open the database', async (context) => {
    const { dir, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath: path.join(dir, 'missing', 'runtime.db'), identity, silenceLimitMs: GENEROUS_SILENCE_MS }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the file at the path is replaced after the thread opened it', async (context) => {
    const { databasePath, dir } = fixture(context);
    const replacement = path.join(dir, 'replacement.db');
    const db = openDatabase(replacement, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)');
    db.close();
    const replacementStat = fs.statSync(replacement);
    const swapAfterOpen = [
      '{',
      "const sqlite = require('node:sqlite');",
      'const Original = sqlite.DatabaseSync;',
      'sqlite.DatabaseSync = class extends Original {',
      '  constructor(...args) {',
      '    super(...args);',
      `    require('node:fs').renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(databasePath)});`,
      '  }',
      '};',
      '}',
    ].join('\n');
    const error = await rejectionOf(
      startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity: { dev: replacementStat.dev, ino: replacementStat.ino }, silenceLimitMs: GENEROUS_SILENCE_MS, code: `${swapAfterOpen}\n${JOURNAL_THREAD_CODE}` }),
    );
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the thread code does not compile', async (context) => {
    const { databasePath, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: 'this is not javascript' }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the thread exits before ready', async (context) => {
    const { databasePath, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: 'process.exit(3);' }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError exactly when the silence limit passes without ready', async (context) => {
    const { databasePath, identity } = fixture(context);
    const timers = fakeTimers();
    const start = tracked(startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: SILENCE_MS, timers, code: 'setInterval(() => {}, 1000);' }));
    await until(() => timers.pending().length === 1);
    timers.advance(SILENCE_MS - 1);
    await turn();
    expect(start.settled()).toBe(false);
    timers.advance(1);
    expect(await start.outcome).toBeInstanceOf(JournalThreadError);
  });
});

describe('journal thread requests', () => {
  it('answers a ping from the embedded thread with the worker thread id', async (context) => {
    const { databasePath, identity } = fixture(context);
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS });
    const first = await client.ping();
    const second = await client.ping();
    expect(first.threadId).toBeGreaterThan(0);
    expect(second.threadId).toBe(first.threadId);
  });

  it('answers an unknown request kind with a request error naming the kind and keeps the embedded thread', async (context) => {
    const { databasePath, identity } = fixture(context);
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS });
    const before = await client.ping();
    const error = await rejectionOf(client.request({ kind: 'contribution' }));
    expect(error).toBeInstanceOf(JournalThreadError);
    expect(String((error as JournalThreadError & { cause: { message: string } }).cause.message)).toContain('contribution');
    const after = await client.ping();
    expect(after.threadId).toBe(before.threadId);
  });

  it('matches each reply to its own request when several are in flight', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const code = fakeThread(marker, "if (message.kind === 'slow') { setImmediate(() => port.postMessage({ id: message.id, ok: true, echo: 'slow' })); return; } port.postMessage({ id: message.id, ok: true, echo: 'fast' });");
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    const replies = await Promise.all([client.request({ kind: 'slow' }), client.request({ kind: 'fast' })]);
    expect(replies.map((reply: Readonly<Record<string, unknown>>) => reply['echo'])).toEqual(['slow', 'fast']);
  });

  it('rejects only the failing request with JournalThreadError carrying the cause and keeps the thread', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const code = fakeThread(
      marker,
      `if (message.kind === 'fail') port.postMessage({ id: message.id, ok: false, error: { name: 'Error', message: 'injected context but has no user.message' } }); else ${PONG}`,
    );
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    const before = await client.ping();
    const error = await rejectionOf(client.request({ kind: 'fail' }));
    expect(error).toBeInstanceOf(JournalThreadError);
    expect((error as JournalThreadError).cause).toMatchObject({ name: 'Error', message: 'injected context but has no user.message' });
    const after = await client.ping();
    expect(after.threadId).toBe(before.threadId);
    expect(spawnCountOf(marker)).toBe(1);
  });
});

describe('journal thread death and replacement', () => {
  it('rejects every request in flight with JournalThreadError when the thread exits', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const code = fakeThread(marker, "if (message.kind === 'die') process.exit(7);");
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    const waiting = rejectionOf(client.request({ kind: 'wait' }));
    const dying = rejectionOf(client.request({ kind: 'die' }));
    expect(await waiting).toBeInstanceOf(JournalThreadError);
    expect(await dying).toBeInstanceOf(JournalThreadError);
  });

  it('rejects the request in flight with JournalThreadError when the thread throws an uncaught error', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const code = fakeThread(marker, "throw new Error('thread broke');");
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    expect(await rejectionOf(client.request({ kind: 'any' }))).toBeInstanceOf(JournalThreadError);
  });

  it('replaces a dead thread at the next request and never replays the failed one', async (context) => {
    const { databasePath, identity, dir, marker } = fixture(context);
    const received = path.join(dir, 'received');
    const code = fakeThread(marker, `fs.appendFileSync(${JSON.stringify(received)}, message.kind + '\\n'); if (message.kind === 'die') process.exit(7); ${PONG}`);
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    const first = await client.ping();
    expect(await rejectionOf(client.request({ kind: 'die' }))).toBeInstanceOf(JournalThreadError);
    expect(spawnCountOf(marker)).toBe(1);
    const second = await client.ping();
    expect(spawnCountOf(marker)).toBe(2);
    expect(second.threadId).not.toBe(first.threadId);
    expect(fs.readFileSync(received, 'utf8')).toBe('ping\ndie\nping\n');
  });

  it('rejects the next request with JournalThreadError when the replacement fails its handshake', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const code = [`if (require('node:fs').existsSync(${JSON.stringify(marker)})) process.exit(9);`, fakeThread(marker, "if (message.kind === 'die') process.exit(7);")].join('\n');
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    expect(await rejectionOf(client.request({ kind: 'die' }))).toBeInstanceOf(JournalThreadError);
    expect(await rejectionOf(client.request({ kind: 'after' }))).toBeInstanceOf(JournalThreadError);
  });
});

describe('journal thread silence watchdog', () => {
  it('terminates a thread that sent nothing within the limit, rejects its request and replaces it at the next request', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const timers = fakeTimers();
    const code = fakeThread(marker, `if (message.kind === 'hang') { Atomics.store(new Int32Array(message.gate), 1, 1); for (;;) {} } ${PONG}`);
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: SILENCE_MS, timers, code });
    const cells = new Int32Array(new SharedArrayBuffer(8));
    const hanging = tracked(client.request({ kind: 'hang', gate: cells.buffer }));
    await until(() => Atomics.load(cells, 1) === 1 && timers.pending().length === 1);
    timers.advance(SILENCE_MS - 1);
    await turn();
    expect(hanging.settled()).toBe(false);
    timers.advance(1);
    expect(await hanging.outcome).toBeInstanceOf(JournalThreadError);
    await client.ping();
    expect(spawnCountOf(marker)).toBe(2);
  });

  it('keeps a thread that posts progress within each limit until it replies', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const timers = fakeTimers();
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: SILENCE_MS, timers, code: fakeThread(marker, GATED_PROGRESS) });
    const cells = new Int32Array(new SharedArrayBuffer(8));
    const reply = tracked(client.request({ kind: 'long', gate: cells.buffer }));
    for (let step = 1; step <= 2; step += 1) {
      await until(() => Atomics.load(cells, 1) === step);
      await until(() => timers.pending().length === 1);
      timers.advance(SILENCE_MS - 1);
      release(cells, step);
    }
    expect(await reply.outcome).toEqual({ steps: 2 });
    expect(spawnCountOf(marker)).toBe(1);
  });

  it('judges silence by what the thread sent, not by what the stalled main thread has processed', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const timers = fakeTimers();
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: SILENCE_MS, timers, code: fakeThread(marker, PROGRESS_ON_SIGNAL) });
    const cells = new Int32Array(new SharedArrayBuffer(8));
    const reply = tracked(client.request({ kind: 'long', gate: cells.buffer }));
    await until(() => timers.pending().length === 1);
    release(cells, 1);
    blockUntil(cells, 1, 1);
    timers.advance(SILENCE_MS);
    release(cells, 2);
    expect(await reply.outcome).toEqual({ steps: 1 });
    expect(spawnCountOf(marker)).toBe(1);
  });

  it('arms no silence timer while no request is pending', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const timers = fakeTimers();
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: SILENCE_MS, timers, code: fakeThread(marker, PONG) });
    const first = await client.ping();
    expect(timers.pending()).toEqual([]);
    timers.advance(SILENCE_MS * 3);
    const second = await client.ping();
    expect(second.threadId).toBe(first.threadId);
    expect(spawnCountOf(marker)).toBe(1);
  });
});

describe('journal thread shutdown', () => {
  it('closes during a respawn handshake: the request rejects, close resolves, no Worker is left and nothing spawns after', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const timers = fakeTimers();
    const code = [
      `if (require('node:fs').existsSync(${JSON.stringify(marker)})) {`,
      `  require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');`,
      '  setInterval(() => {}, 1000);',
      '} else {',
      fakeThread(marker, `if (message.kind === 'die') process.exit(7); ${PONG}`),
      '}',
    ].join('\n');
    const baseline = runningWorkerCount();
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: SILENCE_MS, timers, code });
    expect(await rejectionOf(client.request({ kind: 'die' }))).toBeInstanceOf(JournalThreadError);
    const respawning = tracked(client.ping());
    await until(() => spawnCountOf(marker) === 2);
    expect(respawning.settled()).toBe(false);
    await client.close();
    expect(await respawning.outcome).toBeInstanceOf(JournalThreadError);
    expect(runningWorkerCount()).toBe(baseline);
    expect(await rejectionOf(client.ping())).toBeInstanceOf(JournalThreadError);
    expect(spawnCountOf(marker)).toBe(2);
    expect(runningWorkerCount()).toBe(baseline);
  });

  it('rejects a request in flight at close with JournalThreadError', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: fakeThread(marker, '') });
    const waiting = rejectionOf(client.request({ kind: 'wait' }));
    await client.close();
    expect(await waiting).toBeInstanceOf(JournalThreadError);
  });

  it('rejects requests after close with JournalThreadError and spawns no new thread', async (context) => {
    const { databasePath, identity, marker } = fixture(context);
    const client = await started(context, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: fakeThread(marker, PONG) });
    await client.close();
    expect(await rejectionOf(client.ping())).toBeInstanceOf(JournalThreadError);
    expect(spawnCountOf(marker)).toBe(1);
  });
});

describe('the journal thread connection inside a Worker', () => {
  it('opens WAL with query_only and refuses an INSERT, leaving the table unchanged', async (context) => {
    const { databasePath } = fixture(context);
    const worker = new Worker(new URL('./fixtures/journal-write-probe.ts', import.meta.url), { workerData: { databasePath } });
    const outcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    expect(outcome).toMatchObject({ journalMode: 'wal', queryOnly: 1, insert: { threw: true } });
    expect((outcome['insert'] as { message: string }).message).toMatch(/readonly/);
    const writer = openDatabase(databasePath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    try {
      expect(writer.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    } finally {
      writer.close();
    }
  });
});
