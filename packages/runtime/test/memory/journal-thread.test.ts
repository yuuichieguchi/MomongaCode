import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { JournalThreadError, startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient, JournalThreadOptions } from '../../src/memory/journal-thread-client.ts';
import { openJournalConnection } from '../../src/memory/journal-thread.ts';

const GENEROUS_SILENCE_MS = 10_000;
const SHORT_SILENCE_MS = 300;
const PROGRESS_INTERVAL_MS = 50;
const PROGRESS_TICKS = 20;

type Fixture = { readonly databasePath: string; readonly identity: { dev: number; ino: number }; readonly dir: string };

const fixture = (context: TestContext): Fixture => {
  const dir = withTempDir(context);
  const databasePath = path.join(dir, 'runtime.db');
  const db = openDatabase(databasePath);
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)');
  db.close();
  const stat = fs.statSync(databasePath);
  return { databasePath, identity: { dev: stat.dev, ino: stat.ino }, dir };
};

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
    `fs.appendFileSync(${JSON.stringify(marker)}, 'x');`,
    'const stat = fs.statSync(workerData.databasePath);',
    'parentPort.postMessage({ ready: true, dev: stat.dev, ino: stat.ino });',
    `parentPort.on('message', (message) => { ${onMessage} });`,
  ].join('\n');

const PONG = 'parentPort.postMessage({ id: message.id, ok: true, threadId });';

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

describe('journal thread start and handshake', () => {
  it('resolves start only after the embedded thread reports ready with the database identity', async (context) => {
    const { databasePath, identity } = fixture(context);
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS });
    expect(client.identity).toEqual(identity);
  });

  it('rejects start with JournalThreadError when the ready identity does not match the store file', async (context) => {
    const { databasePath, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ databasePath, identity: { dev: identity.dev, ino: identity.ino + 1 }, silenceLimitMs: GENEROUS_SILENCE_MS }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the thread cannot open the database', async (context) => {
    const { dir, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ databasePath: path.join(dir, 'missing', 'runtime.db'), identity, silenceLimitMs: GENEROUS_SILENCE_MS }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the thread code does not compile', async (context) => {
    const { databasePath, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: 'this is not javascript' }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the thread exits before ready', async (context) => {
    const { databasePath, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: 'process.exit(3);' }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });

  it('rejects start with JournalThreadError when the thread never reports ready within the silence limit', async (context) => {
    const { databasePath, identity } = fixture(context);
    const error = await rejectionOf(startJournalThread({ databasePath, identity, silenceLimitMs: SHORT_SILENCE_MS, code: 'setInterval(() => {}, 1000);' }));
    expect(error).toBeInstanceOf(JournalThreadError);
  });
});

describe('journal thread requests', () => {
  it('answers a ping from the embedded thread with the worker thread id', async (context) => {
    const { databasePath, identity } = fixture(context);
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS });
    const first = await client.ping();
    const second = await client.ping();
    expect(first.threadId).toBeGreaterThan(0);
    expect(second.threadId).toBe(first.threadId);
  });

  it('matches each reply to its own request when several are in flight', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const code = fakeThread(path.join(dir, 'spawns'), 'setTimeout(() => parentPort.postMessage({ id: message.id, ok: true, echo: message.value }), message.delayMs);');
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    const replies = await Promise.all([client.request({ kind: 'echo', value: 'slow', delayMs: 200 }), client.request({ kind: 'echo', value: 'fast', delayMs: 0 })]);
    expect(replies.map((reply: Readonly<Record<string, unknown>>) => reply['echo'])).toEqual(['slow', 'fast']);
  });

  it('rejects only the failing request with JournalThreadError carrying the cause and keeps the thread', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const marker = path.join(dir, 'spawns');
    const code = fakeThread(
      marker,
      `if (message.kind === 'fail') parentPort.postMessage({ id: message.id, ok: false, error: { name: 'Error', message: 'injected context but has no user.message' } }); else ${PONG}`,
    );
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
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
    const { databasePath, identity, dir } = fixture(context);
    const code = fakeThread(path.join(dir, 'spawns'), "if (message.kind === 'die') process.exit(7);");
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    const waiting = rejectionOf(client.request({ kind: 'wait' }));
    const dying = rejectionOf(client.request({ kind: 'die' }));
    expect(await waiting).toBeInstanceOf(JournalThreadError);
    expect(await dying).toBeInstanceOf(JournalThreadError);
  });

  it('rejects the request in flight with JournalThreadError when the thread throws an uncaught error', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const code = fakeThread(path.join(dir, 'spawns'), "throw new Error('thread broke');");
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    expect(await rejectionOf(client.request({ kind: 'any' }))).toBeInstanceOf(JournalThreadError);
  });

  it('replaces a dead thread at the next request and never replays the failed one', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const marker = path.join(dir, 'spawns');
    const received = path.join(dir, 'received');
    const code = fakeThread(marker, `fs.appendFileSync(${JSON.stringify(received)}, message.kind + '\\n'); if (message.kind === 'die') process.exit(7); ${PONG}`);
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    const first = await client.ping();
    expect(await rejectionOf(client.request({ kind: 'die' }))).toBeInstanceOf(JournalThreadError);
    expect(spawnCountOf(marker)).toBe(1);
    const second = await client.ping();
    expect(spawnCountOf(marker)).toBe(2);
    expect(second.threadId).not.toBe(first.threadId);
    expect(fs.readFileSync(received, 'utf8')).toBe('ping\ndie\nping\n');
  });

  it('rejects the next request with JournalThreadError when the replacement fails its handshake', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const marker = path.join(dir, 'spawns');
    const code = [`if (require('node:fs').existsSync(${JSON.stringify(marker)})) process.exit(9);`, fakeThread(marker, "if (message.kind === 'die') process.exit(7);")].join('\n');
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code });
    expect(await rejectionOf(client.request({ kind: 'die' }))).toBeInstanceOf(JournalThreadError);
    expect(await rejectionOf(client.request({ kind: 'after' }))).toBeInstanceOf(JournalThreadError);
  });
});

describe('journal thread silence watchdog', () => {
  it('terminates a thread that stays silent past the limit and rejects its request with JournalThreadError', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const marker = path.join(dir, 'spawns');
    const code = fakeThread(marker, `if (message.kind === 'spin') { for (;;) {} } ${PONG}`);
    const client = await started(context, { databasePath, identity, silenceLimitMs: SHORT_SILENCE_MS, code });
    expect(await rejectionOf(client.request({ kind: 'spin' }))).toBeInstanceOf(JournalThreadError);
    await client.ping();
    expect(spawnCountOf(marker)).toBe(2);
  });

  it('keeps a thread that posts progress more often than the limit until it replies', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const code = fakeThread(
      path.join(dir, 'spawns'),
      `let ticks = 0; const timer = setInterval(() => { ticks += 1; if (ticks < ${PROGRESS_TICKS}) { parentPort.postMessage({ id: message.id, progress: ticks }); return; } clearInterval(timer); parentPort.postMessage({ id: message.id, ok: true, ticks }); }, ${PROGRESS_INTERVAL_MS});`,
    );
    const client = await started(context, { databasePath, identity, silenceLimitMs: SHORT_SILENCE_MS, code });
    const reply = await client.request({ kind: 'long' });
    expect(reply['ticks']).toBe(PROGRESS_TICKS);
  });

  it('does not count idle time between requests as silence', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const marker = path.join(dir, 'spawns');
    const client = await started(context, { databasePath, identity, silenceLimitMs: SHORT_SILENCE_MS, code: fakeThread(marker, PONG) });
    await client.ping();
    await new Promise((resolve) => setTimeout(resolve, SHORT_SILENCE_MS * 3));
    await client.ping();
    expect(spawnCountOf(marker)).toBe(1);
  });
});

describe('journal thread shutdown', () => {
  it('rejects a request in flight at close with JournalThreadError', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: fakeThread(path.join(dir, 'spawns'), '') });
    const waiting = rejectionOf(client.request({ kind: 'wait' }));
    await client.close();
    expect(await waiting).toBeInstanceOf(JournalThreadError);
  });

  it('rejects requests after close with JournalThreadError and spawns no new thread', async (context) => {
    const { databasePath, identity, dir } = fixture(context);
    const marker = path.join(dir, 'spawns');
    const client = await started(context, { databasePath, identity, silenceLimitMs: GENEROUS_SILENCE_MS, code: fakeThread(marker, PONG) });
    await client.close();
    expect(await rejectionOf(client.ping())).toBeInstanceOf(JournalThreadError);
    expect(spawnCountOf(marker)).toBe(1);
  });
});

describe('the journal thread connection', () => {
  it('opens the database in WAL mode with query_only set', (context) => {
    const { databasePath } = fixture(context);
    const db = openJournalConnection(databasePath);
    try {
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(db.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
    } finally {
      db.close();
    }
  });

  it('refuses an INSERT through the connection and leaves the table unchanged', (context) => {
    const { databasePath } = fixture(context);
    const db = openJournalConnection(databasePath);
    try {
      expect(() => db.exec("INSERT INTO events (payload_json) VALUES ('{}')")).toThrow(/readonly/);
    } finally {
      db.close();
    }
    const writer = openDatabase(databasePath);
    try {
      expect(writer.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    } finally {
      writer.close();
    }
  });

  it('reads the last committed snapshot while the main connection holds an immediate write transaction', (context) => {
    const { databasePath } = fixture(context);
    const writer = openDatabase(databasePath);
    const reader = openJournalConnection(databasePath);
    try {
      writer.exec(`INSERT INTO events (payload_json) VALUES ('{"a":1}')`);
      writer.exec('BEGIN IMMEDIATE');
      writer.exec(`INSERT INTO events (payload_json) VALUES ('{"a":2}')`);
      expect(reader.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
      writer.exec('COMMIT');
    } finally {
      reader.close();
      writer.close();
    }
  });
});
