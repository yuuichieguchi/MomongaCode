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

const until = (condition: () => boolean, description: string): Promise<void> => pollUntil(condition, { description, boundMs: DEADLINE_MS });

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

  const journaled = (journal: ReturnType<typeof createPlaceholderJournal>, target: string): void => {
    journal.intend(target, Date.now());
    fs.writeFileSync(target, '');
    journal.complete(target, identityOf(target));
  };

  describe('the journal', () => {
    it('keeps an intent and its completion across instances and forgets them by path', () => {
      const directory = path.join(tempDir(), 'journal');
      const first = createPlaceholderJournal(directory);
      first.intend('/w/.mcp.json', 100);
      first.intend('/w/.envrc', 200);
      first.complete('/w/.envrc', { device: '1', inode: '3' });
      expect(createPlaceholderJournal(directory).records()).toEqual([
        { path: '/w/.envrc', intentMs: 200, form: { kind: 'file', bytes: '' }, identity: { device: '1', inode: '3' } },
        { path: '/w/.mcp.json', intentMs: 100, form: { kind: 'file', bytes: '' }, identity: null },
      ]);
      first.forget('/w/.envrc');
      expect(createPlaceholderJournal(directory).records()).toEqual([{ path: '/w/.mcp.json', intentMs: 100, form: { kind: 'file', bytes: '' }, identity: null }]);
    });

    it('refuses to complete a path that has no intent', () => {
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      expect(() => journal.complete('/w/.mcp.json', { device: '1', inode: '2' })).toThrow('no intent');
    });

    it('refuses a malformed record instead of skipping it', () => {
      const directory = path.join(tempDir(), 'journal');
      const journal = createPlaceholderJournal(directory);
      journal.intend('/w/.mcp.json', 1);
      const [entry] = fs.readdirSync(directory);
      fs.writeFileSync(path.join(directory, entry as string), '{"path": 3}');
      expect(() => journal.records()).toThrow();
    });
  });

  describe('a kill at each step of the write-ahead sequence (intend, create, complete)', () => {
    const intentOf = (journal: ReturnType<typeof createPlaceholderJournal>, target: string, ahead: number): void => {
      journal.intend(target, Date.now() + ahead);
    };

    it('killed after the intent and before the create: nothing is there, the record is forgotten', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      intentOf(journal, path.join(work, '.mcp.json'), 0);
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [] });
      expect(journal.records()).toEqual([]);
    });

    it('killed after the intent and before the create, with a person file of that name already there: the file stays, is reported and its record is kept', () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      fs.writeFileSync(target, '');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      intentOf(journal, target, 60_000);
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect(fs.existsSync(target)).toBe(true);
      expect(journal.records()).toHaveLength(1);
    });

    it('killed after the create and before the completion: the file of the placeholder form with no recorded identity stays, is reported and its record is kept', () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      intentOf(journal, target, 0);
      fs.writeFileSync(target, '');
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect(fs.existsSync(target)).toBe(true);
      expect(journal.records()).toHaveLength(1);
    });

    it('a file the person creates under that name after the crash stays, and the record is reported at every start until the path is gone', () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      intentOf(journal, target, 0);
      expect(recoverPlaceholders(journal, { holders: noHolders }).unrecovered).toEqual([]);
      intentOf(journal, target, 0);
      fs.writeFileSync(target, '');
      expect(recoverPlaceholders(journal, { holders: noHolders }).unrecovered).toEqual([target]);
      expect(recoverPlaceholders(journal, { holders: noHolders }).unrecovered).toEqual([target]);
      expect(fs.existsSync(target)).toBe(true);
      fs.rmSync(target);
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [] });
      expect(journal.records()).toEqual([]);
    });

    it('killed after the create and before the completion, but the file has content: it stays and is reported', () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      intentOf(journal, target, 0);
      fs.writeFileSync(target, '{}');
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect(fs.readFileSync(target, 'utf8')).toBe('{}');
    });

    it('killed after the create and before the completion, while a live sandbox holds the file: it stays and the record is kept', () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      intentOf(journal, target, 0);
      fs.writeFileSync(target, '');
      expect(recoverPlaceholders(journal, { holders: () => new Set([target]) })).toEqual({ removed: [], kept: [], unrecovered: [target] });
      expect(journal.records()).toHaveLength(1);
    });

    it('killed after the completion: the recorded device and inode decide', () => {
      const work = tempDir();
      const target = path.join(work, '.mcp.json');
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      journal.intend(target, Date.now());
      fs.writeFileSync(target, '');
      const identity = identityOf(target);
      journal.complete(target, { ...identity, inode: `${identity.inode}0` });
      expect(recoverPlaceholders(journal, { holders: noHolders }).removed).toEqual([]);
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

    it('reads the mounts of a live thread when the leader has none to show', () => {
      const port = portOf({
        '/proc': ['12'],
        '/proc/12/mountinfo': errno('EINVAL'),
        '/proc/12/task': ['12', '15'],
        '/proc/12/task/12/mountinfo': errno('EINVAL'),
        '/proc/12/task/15/mountinfo': line('/w/.mcp.json'),
      });
      expect(heldMountPoints(port)).toEqual(new Set(['/w/.mcp.json']));
    });

    it('holds nothing when the leader and every thread are gone', () => {
      const port = portOf({ '/proc': ['12'], '/proc/12/mountinfo': errno('EINVAL'), '/proc/12/task': ['12'], '/proc/12/task/12/mountinfo': errno('EINVAL') });
      expect(heldMountPoints(port)).toEqual(new Set());
    });

    it('does not hide an error that is not about a process going away', () => {
      const port = portOf({ '/proc': ['12'], '/proc/12/mountinfo': errno('EIO') });
      expect(() => heldMountPoints(port)).toThrow('EIO');
    });
  });

  describe('recoverPlaceholders', () => {
    it('removes an empty file that is still the object the journal recorded, and forgets it', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      journaled(journal, path.join(work, '.mcp.json'));
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [path.join(work, '.mcp.json')], kept: [], unrecovered: [] });
      expect(fs.existsSync(path.join(work, '.mcp.json'))).toBe(false);
      expect(journal.records()).toEqual([]);
    });

    it('leaves the file alone while a live sandbox still holds it, and keeps the record', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.envrc');
      journaled(journal, target);
      expect(recoverPlaceholders(journal, { holders: () => new Set([target]) })).toEqual({ removed: [], kept: [target], unrecovered: [] });
      expect(fs.existsSync(target)).toBe(true);
      expect(journal.records()).toHaveLength(1);
    });

    it('leaves a person file that replaced the placeholder, because its inode is another one', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.envrc');
      journaled(journal, target);
      fs.rmSync(target);
      fs.writeFileSync(path.join(work, 'other'), '');
      fs.writeFileSync(target, '');
      expect(recoverPlaceholders(journal, { holders: noHolders }).removed).toEqual([]);
      expect(fs.existsSync(target)).toBe(true);
      expect(journal.records()).toEqual([]);
    });

    it('leaves the file when it is no longer empty', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.mcp.json');
      journaled(journal, target);
      fs.writeFileSync(target, '{}');
      expect(recoverPlaceholders(journal, { holders: noHolders }).removed).toEqual([]);
      expect(fs.readFileSync(target, 'utf8')).toBe('{}');
      expect(journal.records()).toEqual([]);
    });

    it('forgets a record whose file is gone', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.mcp.json');
      journaled(journal, target);
      fs.rmSync(target);
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [] });
      expect(journal.records()).toEqual([]);
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
      expect(journal.records().map((record) => record.path).sort()).toEqual(targets);
      for (const record of journal.records()) expect(record.identity).not.toBeNull();
      for (const target of targets) expect(heldMountPoints().has(target)).toBe(true);
      expect(recoverPlaceholders(journal)).toEqual({ removed: [], kept: targets, unrecovered: [] });
      for (const target of targets) expect(fs.existsSync(target)).toBe(true);
    });

    it('leaves empty files in the workspace when the host dies, and the next start removes exactly those', async () => {
      const { work, journal, host, exited } = await startHost();
      const targets = [path.join(work, '.mcp.json'), path.join(work, '.envrc')].sort();
      host.kill('SIGKILL');
      await exited;
      await until(() => targets.every((target) => !heldMountPoints().has(target)), 'the killed host sandbox to disappear');
      for (const target of targets) expect(fs.statSync(target).size).toBe(0);
      expect(recoverPlaceholders(journal).removed.sort()).toEqual(targets);
      for (const target of targets) expect(fs.existsSync(target)).toBe(false);
      expect(journal.records()).toEqual([]);
    });
  });
});
