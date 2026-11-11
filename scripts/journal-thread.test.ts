import { execFileSync, spawnSync } from '@momonga/testkit/child-process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../packages/runtime/src/memory/journal-thread-limits.ts';
import { blobDirectoryOf, migrateRuntimeDatabase } from '../packages/store/src/index.ts';
import { bundle, bundleJournalThread, journalThreadModule, repoRoot, writeJournalThreadModule } from './bundle.ts';
import { buildSea } from './sea.ts';
import { RUNS_MACOS_ARM64_ARTIFACTS } from './support/host.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { productTestEnv, testKernelLock } from '@momonga/testkit';
import { BUSY_WAIT_LIMIT_MS, systemTiming } from '@momonga/foundation';

const PING_FIXTURE = `${repoRoot}test/fixtures/sea/journal-thread-ping.ts`;
const NO_NODE_ENV = (home: string): NodeJS.ProcessEnv => (productTestEnv({ PATH: '/usr/bin:/bin', HOME: home }));

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const sourceModuleState = (): string | null => (fs.existsSync(journalThreadModule) ? sha256(fs.readFileSync(journalThreadModule, 'utf8')) : null);

const freshDatabase = (root: string): { databasePath: string; dev: number; ino: number } => {
  const databasePath = path.join(root, 'runtime.db');
  migrateRuntimeDatabase(databasePath, BUSY_WAIT_LIMIT_MS);
  const stat = fs.statSync(databasePath);
  return { databasePath, dev: stat.dev, ino: stat.ino };
};

const nextMessage = (port: MessagePort, worker: Worker): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const silence = systemTiming.setTimeout(() => {
      stopListening();
      reject(new Error(`the journal thread posted nothing within its silence limit of ${JOURNAL_THREAD_SILENCE_LIMIT_MS} ms`));
    }, JOURNAL_THREAD_SILENCE_LIMIT_MS);
    const stopListening = (): void => {
      systemTiming.clearTimeout(silence);
      port.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onError = (error: Error): void => {
      stopListening();
      reject(error);
    };
    const onExit = (exitCode: number): void => {
      stopListening();
      reject(new Error(`the journal thread exited with code ${exitCode} before it posted a message`));
    };
    const onMessage = (message: Record<string, unknown>): void => {
      stopListening();
      resolve(message);
    };
    port.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });

describe('the journal thread build', () => {
  let root = '';
  let sourceBefore: string | null = null;

  beforeAll(() => {
    root = createTempRoot();
    sourceBefore = sourceModuleState();
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it(
    'bundles the thread entry as code that runs with eval, reports ready on its port with the database identity and answers a ping',
    async () => {
      const code = await bundleJournalThread();
      const { databasePath, dev, ino } = freshDatabase(root);
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(code, { eval: true, workerData: { databasePath, blobsDir: blobDirectoryOf(databasePath), lockName: testKernelLock().name, busyTimeoutMs: BUSY_WAIT_LIMIT_MS, port: port2 }, transferList: [port2] });
      try {
        expect(await nextMessage(port1, worker)).toEqual({ ready: true, dev, ino });
        const reply = nextMessage(port1, worker);
        worker.postMessage({ id: 1, kind: 'ping' });
        expect(await reply).toEqual({ id: 1, ok: true, threadId: worker.threadId });
      } finally {
        port1.close();
        await worker.terminate();
      }
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );

  it(
    'writes a generated module at the given path whose embedded constant is exactly the bundled thread code',
    async () => {
      const target = path.join(root, 'written', 'journal-thread-code.generated.ts');
      fs.mkdirSync(path.dirname(target));
      await writeJournalThreadModule(target);
      const generated = (await import(pathToFileURL(target).href)) as { JOURNAL_THREAD_CODE: string };
      expect(generated.JOURNAL_THREAD_CODE).toBe(await bundleJournalThread());
      expect(fs.readdirSync(path.dirname(target))).toEqual(['journal-thread-code.generated.ts']);
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );

  it(
    'replaces a stale module at the given path and leaves no temporary file beside it',
    async () => {
      const target = path.join(root, 'stale', 'journal-thread-code.generated.ts');
      fs.mkdirSync(path.dirname(target));
      fs.writeFileSync(target, `export const JOURNAL_THREAD_CODE = ${JSON.stringify(randomUUID())};\n`);
      await writeJournalThreadModule(target);
      const replaced = (await import(pathToFileURL(target).href)) as { JOURNAL_THREAD_CODE: string };
      expect(replaced.JOURNAL_THREAD_CODE).toBe(await bundleJournalThread());
      expect(fs.readdirSync(path.dirname(target))).toEqual(['journal-thread-code.generated.ts']);
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );

  it(
    'rejects and leaves no temporary file when the rename onto the target fails',
    async () => {
      const directory = path.join(root, 'rename-fails');
      const target = path.join(directory, 'journal-thread-code.generated.ts');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'occupant'), 'x');
      await expect(writeJournalThreadModule(target)).rejects.toThrow();
      expect(fs.readdirSync(directory)).toEqual(['journal-thread-code.generated.ts']);
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );

  it('ignores every generated module by pattern, in any package', () => {
    const relative = path.join('packages', 'store', 'src', 'x.generated.ts');
    expect(execFileSync('git', ['check-ignore', '--no-index', relative], { cwd: repoRoot, encoding: 'utf8' })).toBe(`${relative}\n`);
  });

  it('keeps the source-tree generated module out of git', () => {
    const relative = path.relative(repoRoot, journalThreadModule);
    expect(relative).toBe(path.join('packages', 'runtime', 'src', 'memory', 'journal-thread-code.generated.ts'));
    expect(execFileSync('git', ['check-ignore', relative], { cwd: repoRoot, encoding: 'utf8' })).toBe(`${relative}\n`);
  });

  it(
    'generates the thread module at the given path before bundling an entry that embeds it',
    async () => {
      const target = path.join(root, 'for-bundle', 'journal-thread-code.generated.ts');
      fs.mkdirSync(path.dirname(target));
      const outfile = path.join(root, 'ping.mjs');
      await bundle({ entry: PING_FIXTURE, outfile, journalThreadModule: target, ruleVerifierThreadModule: path.join(path.dirname(target), 'rule-verifier-thread-code.generated.ts') });
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(outfile)).toBe(true);
      expect(sourceModuleState()).toBe(sourceBefore);
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );
});

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('the journal thread in the single executable', () => {
  let root = '';
  let binary = '';
  let sourceBefore: string | null = null;

  beforeAll(async () => {
    root = createTempRoot();
    sourceBefore = sourceModuleState();
    binary = path.join(root, 'journal-thread-ping');
    const generated = path.join(root, 'generated', 'journal-thread-code.generated.ts');
    fs.mkdirSync(path.dirname(generated));
    await buildSea({ entry: PING_FIXTURE, output: binary, workDir: path.join(root, 'work'), journalThreadModule: generated });
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('starts the embedded thread, completes the handshake and answers a ping with Node absent from PATH, running the bundled thread code', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const result = spawnSync(binary, [home], { encoding: 'utf8', env: NO_NODE_ENV(home) });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ pinged: true, codeSha256: sha256(await bundleJournalThread()) });
    expect(sourceModuleState()).toBe(sourceBefore);
  }, UNBOUNDED_BUILD_WAIT_MS);
});
