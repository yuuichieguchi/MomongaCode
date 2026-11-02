import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BWRAP_PATH, createPlaceholderJournal, heldMountPoints, identityOf, recoverPlaceholders } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';

const POLL_MS = 25;
const DEADLINE_MS = 20_000;

const until = async (condition: () => boolean, description: string): Promise<void> => {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
};

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
    fs.writeFileSync(target, '');
    journal.record({ path: target, ...identityOf(target) });
  };

  describe('the journal', () => {
    it('keeps a record across instances and forgets it by path', () => {
      const directory = path.join(tempDir(), 'journal');
      const first = createPlaceholderJournal(directory);
      first.record({ path: '/w/.mcp.json', device: '1', inode: '2' });
      first.record({ path: '/w/.envrc', device: '1', inode: '3' });
      expect(createPlaceholderJournal(directory).records().sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: '/w/.envrc', device: '1', inode: '3' },
        { path: '/w/.mcp.json', device: '1', inode: '2' },
      ]);
      first.forget('/w/.envrc');
      expect(createPlaceholderJournal(directory).records()).toEqual([{ path: '/w/.mcp.json', device: '1', inode: '2' }]);
    });

    it('refuses a malformed record instead of skipping it', () => {
      const directory = path.join(tempDir(), 'journal');
      const journal = createPlaceholderJournal(directory);
      journal.record({ path: '/w/.mcp.json', device: '1', inode: '2' });
      const [entry] = fs.readdirSync(directory);
      fs.writeFileSync(path.join(directory, entry as string), '{"path": 3}');
      expect(() => journal.records()).toThrow();
    });
  });

  describe('recoverPlaceholders', () => {
    it('removes an empty file that is still the object the journal recorded, and forgets it', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      journaled(journal, path.join(work, '.mcp.json'));
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [path.join(work, '.mcp.json')], kept: [] });
      expect(fs.existsSync(path.join(work, '.mcp.json'))).toBe(false);
      expect(journal.records()).toEqual([]);
    });

    it('leaves the file alone while a live sandbox still holds it, and keeps the record', () => {
      const work = tempDir();
      const journal = createPlaceholderJournal(path.join(tempDir(), 'journal'));
      const target = path.join(work, '.envrc');
      journaled(journal, target);
      expect(recoverPlaceholders(journal, { holders: () => new Set([target]) })).toEqual({ removed: [], kept: [target] });
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
      expect(recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [] });
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
      for (const target of targets) expect(heldMountPoints().has(target)).toBe(true);
      expect(recoverPlaceholders(journal)).toEqual({ removed: [], kept: targets });
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
