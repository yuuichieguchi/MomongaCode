import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcess } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, pollUntil } from '@momonga/testkit';
import { DEFAULT_BWRAP_PATH, createPlaceholderJournal, heldMountPoints, identityOf, recoverPlaceholders } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DEADLINE_MS = 20_000;

const until = (condition: () => boolean | Promise<boolean>, description: string): Promise<void> => pollUntil(condition, { description, boundMs: DEADLINE_MS });

const HOST_SCRIPT = fileURLToPath(new URL('./placeholder-host.ts', import.meta.url));
const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);

describe('the placeholder journal and the recovery at runtime start', () => {
  let created: string[] = [];
  let hosts: ChildProcess[] = [];

  const tempDir = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  beforeEach(() => {
    created = [];
    hosts = [];
  });

  afterEach(() => {
    for (const host of hosts) host.kill('SIGKILL');
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  const noHolders = (): ReadonlySet<string> => new Set();

  const journaled = async (journal: ReturnType<typeof createPlaceholderJournal>, target: string): Promise<void> => {
    await journal.intend(target, Date.now());
    fs.writeFileSync(target, '');
    await journal.complete(target, await identityOf(target));
  };

  describe('the journal', () => {
    it('keeps an intent and its completion across instances and forgets them by path', async () => {
      const directory = path.join(tempDir(), 'journal');
      const first = createPlaceholderJournal(directory);
      await first.intend('/w/.mcp.json', 100);
      await first.intend('/w/.envrc', 200);
      await first.complete('/w/.envrc', { device: '1', inode: '3', changed: '4' });
      expect((await createPlaceholderJournal(directory).records())).toEqual([
        { path: '/w/.envrc', intentMs: 200, form: { kind: 'file', bytes: '' }, identity: { device: '1', inode: '3', changed: '4' } },
        { path: '/w/.mcp.json', intentMs: 100, form: { kind: 'file', bytes: '' }, identity: null },
      ]);
      await first.forget('/w/.envrc');
      expect((await createPlaceholderJournal(directory).records())).toEqual([{ path: '/w/.mcp.json', intentMs: 100, form: { kind: 'file', bytes: '' }, identity: null }]);
    });

    it('refuses to complete a path that has no intent', async () => {
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await expect(journal.complete('/w/.mcp.json', { device: '1', inode: '2', changed: '3' })).rejects.toThrow('no intent');
    });

    it('refuses a malformed record instead of skipping it', async () => {
      const directory = path.join(tempDir(), 'journal');
      const journal = createPlaceholderJournal(directory);
      await journal.intend('/w/.mcp.json', 1);
      const [entry] = fs.readdirSync(directory);
      fs.writeFileSync(path.join(directory, entry as string), '{"path": 3}');
      await expect(journal.records()).rejects.toThrow();
    });
  });

  describe('a kill at each step of the write-ahead sequence (intend, create, complete)', () => {
    const intentOf = async (journal: ReturnType<typeof createPlaceholderJournal>, target: string, ahead: number): Promise<void> => {
      await journal.intend(target, Date.now() + ahead);
    };

    it('killed after the intent and before the create: nothing is there, the record is forgotten', async () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await intentOf(journal, path.join(work, '.mcp.json'), 0);
      expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [] });
      expect((await journal.records())).toEqual([]);
    });

    it('killed after the intent and before the create, with a person file of that name already there: the file stays, is reported and its record is kept', async () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      fs.writeFileSync(target, '');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await intentOf(journal, target, 60_000);
      expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect(fs.existsSync(target)).toBe(true);
      expect((await journal.records())).toHaveLength(1);
    });

    it('killed after the create and before the completion: the file of the placeholder form with no recorded identity stays, is reported and its record is kept', async () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await intentOf(journal, target, 0);
      fs.writeFileSync(target, '');
      expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect(fs.existsSync(target)).toBe(true);
      expect((await journal.records())).toHaveLength(1);
    });

    it('a file the person creates under that name after the crash stays, and the record is reported at every start until the path is gone', async () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await intentOf(journal, target, 0);
      expect((await recoverPlaceholders(journal, { holders: noHolders })).unrecovered).toEqual([]);
      await intentOf(journal, target, 0);
      fs.writeFileSync(target, '');
      expect((await recoverPlaceholders(journal, { holders: noHolders })).unrecovered).toEqual([target]);
      expect((await recoverPlaceholders(journal, { holders: noHolders })).unrecovered).toEqual([target]);
      expect(fs.existsSync(target)).toBe(true);
      fs.rmSync(target);
      expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [] });
      expect((await journal.records())).toEqual([]);
    });

    it('killed after the create and before the completion, but the file has content: it stays and is reported', async () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await intentOf(journal, target, 0);
      fs.writeFileSync(target, '{}');
      expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect(fs.readFileSync(target, 'utf8')).toBe('{}');
    });

    it('killed after the create and before the completion, while a live sandbox holds the file: it stays and the record is kept', async () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await intentOf(journal, target, 0);
      fs.writeFileSync(target, '');
      expect(await recoverPlaceholders(journal, { holders: () => new Set([target]) })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect((await journal.records())).toHaveLength(1);
    });

    it('a file under the same device and inode that is not the recorded one (an inode the file system reused) stays', async () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await journal.intend(target, Date.now());
      fs.writeFileSync(target, '');
      const identity = await identityOf(target);
      await journal.complete(target, { ...identity, changed: `${identity.changed}1` });
      expect((await recoverPlaceholders(journal, { holders: noHolders })).removed).toEqual([]);
      expect(fs.existsSync(target)).toBe(true);
    });

    it('killed after the completion: the recorded device and inode decide', async () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await journal.intend(target, Date.now());
      fs.writeFileSync(target, '');
      const identity = await identityOf(target);
      await journal.complete(target, { ...identity, inode: `${identity.inode}0` });
      expect((await recoverPlaceholders(journal, { holders: noHolders })).removed).toEqual([]);
      expect(fs.existsSync(target)).toBe(true);
    });
  });

  describe('heldMountPoints with a zombie thread-group leader (mounts_open_common answers EINVAL when task->nsproxy is gone)', () => {
    const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    const line = (mountPoint: string): string => `36 35 98:0 /null ${mountPoint} rw - tmpfs tmpfs rw\n`;
    const portOf = (files: Record<string, string | string[] | NodeJS.ErrnoException>) => ({
      list: (directory: string): string[] => {
        const entry = files[directory];
        if (entry instanceof Error) throw entry;
        if (!Array.isArray(entry)) throw errno('ENOENT');
        return entry;
      },
      read: (file: string): string => {
        const entry = files[file];
        if (entry instanceof Error) throw entry;
        if (typeof entry !== 'string') throw errno('ENOENT');
        return entry;
      },
    });

    it('reads the mounts of a live thread when the leader has none to show', async () => {
      const port = portOf({
        '/proc': ['12'],
        '/proc/12/mountinfo': errno('EINVAL'),
        '/proc/12/task': ['12', '15'],
        '/proc/12/task/12/mountinfo': errno('EINVAL'),
        '/proc/12/task/15/mountinfo': line('/w/.mcp.json'),
      });
      expect(await heldMountPoints(port)).toEqual(new Set(['/w/.mcp.json']));
    });

    it('holds nothing when the leader and every thread are gone', async () => {
      const port = portOf({ '/proc': ['12'], '/proc/12/mountinfo': errno('EINVAL'), '/proc/12/task': ['12'], '/proc/12/task/12/mountinfo': errno('EINVAL') });
      expect(await heldMountPoints(port)).toEqual(new Set());
    });

    it('does not hide an error that is not about a process going away', async () => {
      const port = portOf({ '/proc': ['12'], '/proc/12/mountinfo': errno('EIO') });
      await expect(heldMountPoints(port)).rejects.toThrow('EIO');
    });
  });

  describe('recoverPlaceholders', () => {
    it('removes an empty file that is still the object the journal recorded, and forgets it', async () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      await journaled(journal, path.join(work, '.mcp.json'));
      expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [path.join(work, '.mcp.json')], kept: [], unrecovered: [] });
      expect(fs.existsSync(path.join(work, '.mcp.json'))).toBe(false);
      expect((await journal.records())).toEqual([]);
    });

    it('leaves the file alone while a live sandbox still holds it, and keeps the record', async () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.envrc');
      await journaled(journal, target);
      expect(await recoverPlaceholders(journal, { holders: () => new Set([target]) })).toEqual({ removed: [], kept: [target], unrecovered: [] });
      expect(fs.existsSync(target)).toBe(true);
      expect((await journal.records())).toHaveLength(1);
    });

    it('leaves a person file that replaced the placeholder, because its inode is another one', async () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.envrc');
      await journaled(journal, target);
      fs.rmSync(target);
      fs.writeFileSync(path.join(work, 'other'), '');
      fs.writeFileSync(target, '');
      expect((await recoverPlaceholders(journal, { holders: noHolders })).removed).toEqual([]);
      expect(fs.existsSync(target)).toBe(true);
      expect((await journal.records())).toEqual([]);
    });

    it('leaves the file when it is no longer empty', async () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.mcp.json');
      await journaled(journal, target);
      fs.writeFileSync(target, '{}');
      expect((await recoverPlaceholders(journal, { holders: noHolders })).removed).toEqual([]);
      expect(fs.readFileSync(target, 'utf8')).toBe('{}');
      expect((await journal.records())).toEqual([]);
    });

    it('forgets a record whose file is gone', async () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.mcp.json');
      await journaled(journal, target);
      fs.rmSync(target);
      expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [] });
      expect((await journal.records())).toEqual([]);
    });
  });

  describe.runIf(HAS_BWRAP)('after a real host SIGKILL, with real bwrap', () => {
    const startHost = async () => {
      const work = tempDir();
      const control = tempDir();
      const journalDirectory = path.join(tempDir(), 'journal');
      fs.mkdirSync(journalDirectory, { recursive: true });
      const mkfifo = spawn('/usr/bin/mkfifo', [path.join(control, 'gate')]);
      await new Promise((resolve) => mkfifo.once('exit', resolve));
      const host = spawn(process.execPath, [HOST_SCRIPT, work, tempDir(), journalDirectory, control], { stdio: 'inherit' });
      hosts.push(host);
      const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
      await until(() => fs.existsSync(path.join(control, 'ready')), 'the sandboxed command to start');
      return { work, journal: createPlaceholderJournal(journalDirectory), host, exited };
    };

    it('records both placeholders before the command runs, and a running sandbox is left alone', async () => {
      const { work, journal } = await startHost();
      const targets = [path.join(work, '.mcp.json'), path.join(work, '.envrc')].sort();
      expect((await journal.records()).map((record) => record.path).sort()).toEqual(targets);
      for (const record of (await journal.records())) expect(record.identity).not.toBeNull();
      for (const target of targets) expect((await heldMountPoints()).has(target)).toBe(true);
      expect(await recoverPlaceholders(journal)).toEqual({ removed: [], kept: targets, unrecovered: [] });
      for (const target of targets) expect(fs.existsSync(target)).toBe(true);
    });

    it('leaves empty files in the workspace when the host dies, and the next start removes exactly those', async () => {
      const { work, journal, host, exited } = await startHost();
      const targets = [path.join(work, '.mcp.json'), path.join(work, '.envrc')].sort();
      host.kill('SIGKILL');
      await exited;
      await until(async () => {
        const held = await heldMountPoints();
        return targets.every((target) => !held.has(target));
      }, 'the killed host sandbox to disappear');
      for (const target of targets) expect(fs.statSync(target).size).toBe(0);
      expect((await recoverPlaceholders(journal)).removed.sort()).toEqual(targets);
      for (const target of targets) expect(fs.existsSync(target)).toBe(false);
      expect((await journal.records())).toEqual([]);
    });
  });
});
