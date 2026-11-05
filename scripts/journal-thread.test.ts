import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../packages/foundation/src/sqlite.ts';
import { bundle, bundleJournalThread, journalThreadModule, repoRoot, writeJournalThreadModule } from './bundle.ts';
import { buildSea } from './sea.ts';
import { RUNS_MACOS_ARM64_ARTIFACTS } from './support/host.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const BUILD_TIMEOUT_MS = 300_000;
const PING_FIXTURE = `${repoRoot}test/fixtures/sea/journal-thread-ping.ts`;
const NO_NODE_ENV = (home: string): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', HOME: home });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const freshDatabase = (root: string): { databasePath: string; dev: number; ino: number } => {
  const databasePath = path.join(root, 'runtime.db');
  openDatabase(databasePath).close();
  const stat = fs.statSync(databasePath);
  return { databasePath, dev: stat.dev, ino: stat.ino };
};

const nextMessage = (worker: Worker): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      worker.off('message', onMessage);
      reject(error);
    };
    const onMessage = (message: Record<string, unknown>): void => {
      worker.off('error', onError);
      resolve(message);
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
  });

describe('the journal thread build', () => {
  let root = '';

  beforeAll(() => {
    root = createTempRoot();
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it(
    'bundles the thread entry as code that runs with eval, reports ready with the database identity and answers a ping',
    async () => {
      const code = await bundleJournalThread();
      const { databasePath, dev, ino } = freshDatabase(root);
      const worker = new Worker(code, { eval: true, workerData: { databasePath } });
      try {
        expect(await nextMessage(worker)).toEqual({ ready: true, dev, ino });
        const reply = nextMessage(worker);
        worker.postMessage({ id: 1, kind: 'ping' });
        expect(await reply).toEqual({ id: 1, ok: true, threadId: worker.threadId });
      } finally {
        await worker.terminate();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'writes a generated module whose embedded constant is exactly the bundled thread code',
    async () => {
      fs.rmSync(journalThreadModule, { force: true });
      await writeJournalThreadModule();
      const generated = (await import(pathToFileURL(journalThreadModule).href)) as { JOURNAL_THREAD_CODE: string };
      expect(generated.JOURNAL_THREAD_CODE).toBe(await bundleJournalThread());
    },
    BUILD_TIMEOUT_MS,
  );

  it('keeps the generated module out of git', () => {
    const relative = path.relative(repoRoot, journalThreadModule);
    expect(relative).toBe(path.join('packages', 'runtime', 'src', 'memory', 'journal-thread-code.generated.ts'));
    expect(execFileSync('git', ['check-ignore', relative], { cwd: repoRoot, encoding: 'utf8' })).toBe(`${relative}\n`);
  });

  it(
    'generates the thread module before bundling an entry that embeds it',
    async () => {
      fs.rmSync(journalThreadModule, { force: true });
      const outfile = path.join(root, 'ping.mjs');
      await bundle({ entry: PING_FIXTURE, outfile });
      expect(fs.existsSync(journalThreadModule)).toBe(true);
      expect(fs.existsSync(outfile)).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );
});

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('the journal thread in the single executable', () => {
  let root = '';
  let binary = '';

  beforeAll(async () => {
    root = createTempRoot();
    binary = path.join(root, 'journal-thread-ping');
    await buildSea({ entry: PING_FIXTURE, output: binary, workDir: path.join(root, 'work') });
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    removeTempRoot(root);
  });

  it('starts the embedded thread, completes the handshake and answers a ping with Node absent from PATH, running the bundled thread code', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const result = spawnSync(binary, [home], { encoding: 'utf8', env: NO_NODE_ENV(home) });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ pinged: true, codeSha256: sha256(await bundleJournalThread()) });
  });
});
