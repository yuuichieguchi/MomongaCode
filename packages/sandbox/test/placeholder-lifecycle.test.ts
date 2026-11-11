import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createBubblewrapSandbox, createPlaceholderJournal, nodeFilesystemPort, recoverPlaceholders } from '@momonga/sandbox';
import type { PlaceholderJournal, SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const STAND_IN_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do
  shift
done
shift
exec "$@"
`;

const KILL_HOST = fileURLToPath(new URL('./placeholder-kill-host.ts', import.meta.url));

type Failure = { method: 'intend' | 'complete' | 'forget'; nth: number; persistent: boolean };

const failingJournal = (inner: PlaceholderJournal, failure: Failure): PlaceholderJournal => {
  const calls = { intend: 0, complete: 0, forget: 0 };
  let dead = false;
  const guard = <T>(method: Failure['method'], act: () => T): T => {
    calls[method] += 1;
    if (dead || (method === failure.method && calls[method] === failure.nth)) {
      dead = dead || failure.persistent;
      throw new Error(`the journal failed at ${method} ${calls[method]}`);
    }
    return act();
  };
  return {
    intend: (target, intentMs, form) => guard('intend', () => inner.intend(target, intentMs, form)),
    complete: (target, identity) => guard('complete', () => inner.complete(target, identity)),
    forget: (target) => guard('forget', () => inner.forget(target)),
    records: () => inner.records(),
  };
};

describe('the life of a placeholder (stand-in bwrap)', () => {
  let base = '';
  let work = '';
  let tmpRoot = '';
  let journalDirectory = '';
  let held: ReadonlySet<string> = new Set();

  const mcp = (): string => path.join(work, '.mcp.json');
  const envrc = (): string => path.join(work, '.envrc');

  const policy = (): SandboxPolicy => ({
    writableRoots: [work],
    writeDenied: [mcp(), envrc()],
    writeDeniedLiterals: [],
    readDenied: [],
    network: 'deny',
    fileRules: EMPTY_FILE_RULES,
    protectedSet: EMPTY_PROTECTED_SET,
  });

  const sandboxWith = (journal: PlaceholderJournal) =>
    createBubblewrapSandbox({ bwrapPath: path.join(base, 'bwrap'), tmpRoot, killGraceMs: 300, journal, holders: () => held });

  const start = (journal: PlaceholderJournal, script: string) =>
    sandboxWith(journal).spawn({ argv: ['/bin/sh', '-c', script], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy(), new AbortController().signal);

  beforeEach(() => {
    base = fs.realpathSync(makeTempDir());
    work = path.join(base, 'work');
    tmpRoot = path.join(base, 'tmp');
    journalDirectory = path.join(base, 'journal');
    fs.mkdirSync(work);
    fs.mkdirSync(tmpRoot);
    fs.writeFileSync(path.join(base, 'bwrap'), STAND_IN_BWRAP, { mode: 0o755 });
    held = new Set();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const real = (): PlaceholderJournal => createPlaceholderJournal(journalDirectory);

  describe('a journal that fails while the placeholders are created', () => {
    it('fails at the first intent: nothing is created and the error is the journal error', async () => {
      await expect((async () => start(failingJournal(real(), { method: 'intend', nth: 1, persistent: false }), 'true'))()).rejects.toThrow('the journal failed at intend 1');
      expect(fs.readdirSync(work)).toEqual([]);
      expect(real().records()).toEqual([]);
    });

    it('fails at the completion of the first placeholder: the file it created is removed, the intent forgotten, the original error kept', async () => {
      await expect((async () => start(failingJournal(real(), { method: 'complete', nth: 1, persistent: false }), 'true'))()).rejects.toThrow('the journal failed at complete 1');
      expect(fs.readdirSync(work)).toEqual([]);
      expect(real().records()).toEqual([]);
    });

    it('fails at the completion of the second placeholder: the first is released too', async () => {
      await expect((async () => start(failingJournal(real(), { method: 'complete', nth: 2, persistent: false }), 'true'))()).rejects.toThrow('the journal failed at complete 2');
      expect(fs.readdirSync(work)).toEqual([]);
      expect(real().records()).toEqual([]);
    });

    it('fails to clean up as well: every cleanup is tried, every failure is reported with the original one', async () => {
      try {
        await start(failingJournal(real(), { method: 'complete', nth: 2, persistent: true }), 'true');
        expect.unreachable('the spawn should have failed');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        const messages = (error as AggregateError).errors.map((entry: Error) => entry.message);
        expect(messages[0]).toBe('the journal failed at complete 2');
        expect(messages.length).toBeGreaterThanOrEqual(3);
      }
      expect(fs.readdirSync(work).sort()).toEqual([]);
    });

  });

  describe('a host SIGKILL injected through the journal at each step', () => {
    const killedAt = async (step: 'before-intend' | 'before-complete' | 'after-complete') => {
      const host = spawn(process.execPath, [KILL_HOST, work, tmpRoot, journalDirectory, path.join(base, 'bwrap'), step], { stdio: 'inherit' });
      const exit = await new Promise<string | null>((resolve) => host.once('exit', (_code, signal) => resolve(signal)));
      expect(exit).toBe('SIGKILL');
    };

    it('before the intent is written: no file, no record', async () => {
      await killedAt('before-intend');
      expect(fs.readdirSync(work)).toEqual([]);
      expect(real().records()).toEqual([]);
    });

    it('after the file was created and before the completion: an intent-only record, and recovery removes the empty file', async () => {
      await killedAt('before-complete');
      expect(fs.readdirSync(work)).toEqual(['.mcp.json']);
      expect(real().records().map((record) => record.identity)).toEqual([null]);
      expect(recoverPlaceholders(real(), { holders: () => new Set() }).removed).toEqual([mcp()]);
      expect(fs.readdirSync(work)).toEqual([]);
    });

    it('after the completion and before the spawn: a complete record, and recovery removes the empty file', async () => {
      await killedAt('after-complete');
      expect(real().records().map((record) => record.identity === null)).toEqual([false]);
      expect(recoverPlaceholders(real(), { holders: () => new Set() }).removed).toEqual([mcp()]);
      expect(fs.readdirSync(work)).toEqual([]);
    });
  });

  describe('a journal that fails while the placeholders are released', () => {
    it('keeps releasing the other placeholders and still removes the private tmp directory, then reports the failure', async () => {
      const proc = start(failingJournal(real(), { method: 'forget', nth: 1, persistent: false }), 'true');
      await expect(run(await proc)).rejects.toThrow('the journal failed at forget 1');
      expect(fs.readdirSync(work)).toEqual([]);
      expect(fs.readdirSync(tmpRoot)).toEqual([]);
    });
  });

  describe('release removes only the file it created', () => {
    it('leaves a person file that replaced the placeholder during the command', async () => {
      await run(await start(real(), `rm ${mcp()} && : > ${mcp()}`));
      expect(fs.existsSync(mcp())).toBe(true);
      expect(fs.existsSync(envrc())).toBe(false);
      expect(real().records()).toEqual([]);
    });
  });

  describe('release while another sandbox still holds the path (another runtime on the same workspace)', () => {
    it('leaves the file and keeps the record, then removes it at a later release once nobody holds it', async () => {
      const journal = real();
      const sandbox = sandboxWith(journal);
      const command = { argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } };
      held = new Set([mcp()]);
      await run(await sandbox.spawn(command, policy(), new AbortController().signal));
      expect(fs.existsSync(mcp())).toBe(true);
      expect(fs.existsSync(envrc())).toBe(false);
      expect(journal.records().map((record) => record.path)).toEqual([mcp()]);
      held = new Set();
      await run(await sandbox.spawn({ ...command, argv: ['/bin/sh', '-c', 'true'] }, { ...policy(), writeDenied: [envrc()] }, new AbortController().signal));
      expect(fs.existsSync(mcp())).toBe(false);
      expect(journal.records()).toEqual([]);
    });

    it('removes a kept file when the sweep runs after nobody holds it, with no further command', async () => {
      const journal = real();
      const sandbox = sandboxWith(journal);
      held = new Set([mcp()]);
      await run(await sandbox.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy(), new AbortController().signal));
      sandbox.sweep?.();
      expect(fs.existsSync(mcp())).toBe(true);
      expect(journal.records().map((record) => record.path)).toEqual([mcp()]);
      held = new Set();
      sandbox.sweep?.();
      expect(fs.existsSync(mcp())).toBe(false);
      expect(journal.records()).toEqual([]);
    });

    it('never sweeps a kept file that a command planned after it was kept has reserved but bwrap has not mounted yet', async () => {
      const journal = real();
      const sandbox = sandboxWith(journal);
      const command = { argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } };
      held = new Set([mcp()]);
      await run(await sandbox.spawn(command, policy(), new AbortController().signal));
      expect(fs.existsSync(mcp())).toBe(true);
      held = new Set();
      const planned = await sandbox.spawn({ ...command, argv: ['/bin/sh', '-c', 'sleep 0.2'] }, { ...policy(), writeDenied: [mcp()] }, new AbortController().signal);
      sandbox.sweep?.();
      expect(fs.existsSync(mcp())).toBe(true);
      expect(journal.records().map((record) => record.path)).toEqual([mcp()]);
      await run(await planned);
      expect(fs.existsSync(mcp())).toBe(false);
      expect(journal.records()).toEqual([]);
    });

    it('reports a failing sweep once per distinct failure until it changes or clears, and keeps the file meanwhile', async () => {
      const journal = real();
      let failure: Error | undefined;
      const sandbox = createBubblewrapSandbox({
        bwrapPath: path.join(base, 'bwrap'),
        tmpRoot,
        killGraceMs: 300,
        journal,
        holders: () => held,
        filesystem: {
          ...nodeFilesystemPort,
          removePlaceholder: (target, identity, form) => {
            if (failure !== undefined) throw failure;
            nodeFilesystemPort.removePlaceholder(target, identity, form);
          },
        },
      });
      held = new Set([mcp()]);
      await run(await sandbox.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy(), new AbortController().signal));
      held = new Set();
      failure = new Error('the placeholder could not be removed');
      await expect((async () => sandbox.sweep?.())()).rejects.toThrow('the placeholder could not be removed');
      await expect((async () => { await sandbox.sweep?.(); })()).resolves.toBeUndefined();
      await expect((async () => { await sandbox.sweep?.(); })()).resolves.toBeUndefined();
      failure = new Error('the journal is read-only');
      await expect((async () => sandbox.sweep?.())()).rejects.toThrow('the journal is read-only');
      await expect((async () => { await sandbox.sweep?.(); })()).resolves.toBeUndefined();
      expect(fs.existsSync(mcp())).toBe(true);
      failure = undefined;
      sandbox.sweep?.();
      expect(fs.existsSync(mcp())).toBe(false);
    });

    it('reports a failing sweep again when it recurs after it cleared', async () => {
      const journal = real();
      let failing = false;
      const sandbox = createBubblewrapSandbox({
        bwrapPath: path.join(base, 'bwrap'),
        tmpRoot,
        killGraceMs: 300,
        journal,
        holders: () => held,
        filesystem: {
          ...nodeFilesystemPort,
          removePlaceholder: (target, identity, form) => {
            if (failing) throw new Error('the placeholder could not be removed');
            nodeFilesystemPort.removePlaceholder(target, identity, form);
          },
        },
      });
      const command = { argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } };
      held = new Set([mcp()]);
      await run(await sandbox.spawn(command, policy(), new AbortController().signal));
      held = new Set();
      failing = true;
      await expect((async () => sandbox.sweep?.())()).rejects.toThrow('the placeholder could not be removed');
      await expect((async () => { await sandbox.sweep?.(); })()).resolves.toBeUndefined();
      failing = false;
      sandbox.sweep?.();
      expect(fs.existsSync(mcp())).toBe(false);
      held = new Set([mcp()]);
      await run(await sandbox.spawn(command, policy(), new AbortController().signal));
      held = new Set();
      failing = true;
      await expect((async () => sandbox.sweep?.())()).rejects.toThrow('the placeholder could not be removed');
    });

    it('reports a sweep that cannot remove the file, and keeps it for the next sweep', async () => {
      const journal = real();
      const failure = new Error('the placeholder could not be removed');
      let failing = false;
      const sandbox = createBubblewrapSandbox({
        bwrapPath: path.join(base, 'bwrap'),
        tmpRoot,
        killGraceMs: 300,
        journal,
        holders: () => held,
        filesystem: {
          ...nodeFilesystemPort,
          removePlaceholder: (target, identity, form) => {
            if (failing) throw failure;
            nodeFilesystemPort.removePlaceholder(target, identity, form);
          },
        },
      });
      held = new Set([mcp()]);
      await run(await sandbox.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy(), new AbortController().signal));
      held = new Set();
      failing = true;
      await expect((async () => sandbox.sweep?.())()).rejects.toThrow(failure);
      failing = false;
      sandbox.sweep?.();
      expect(fs.existsSync(mcp())).toBe(false);
    });
  });
});
