import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaceholderForm } from '@momonga/foundation';
import { createPlaceholderJournal, identityOf, isStillThePlaceholder, recoverPlaceholders } from '@momonga/sandbox';
import type { PlaceholderJournal } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';

const EMPTY_FILE: PlaceholderForm = { kind: 'file', bytes: '' };
const COMMONDIR_FORM: PlaceholderForm = { kind: 'file', bytes: '.\n' };
const DIRECTORY_FORM: PlaceholderForm = { kind: 'directory' };

let base = '';
let work = '';
let journalDirectory = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  journalDirectory = path.join(base, 'journal');
  fs.mkdirSync(work);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const noHolders = (): ReadonlySet<string> => new Set();

const makeForm = (target: string, form: PlaceholderForm): void => {
  if (form.kind === 'directory') fs.mkdirSync(target);
  else fs.writeFileSync(target, form.bytes);
};

const journaled = async (journal: PlaceholderJournal, target: string, form: PlaceholderForm): Promise<void> => {
  await journal.intend(target, Date.now(), form);
  makeForm(target, form);
  await journal.complete(target, await identityOf(target));
};

describe('the journal record carries the form', () => {
  it('keeps the form of an intent and of its completion across instances', async () => {
    const first = createPlaceholderJournal(journalDirectory);
    await first.intend('/w/.git', 100, DIRECTORY_FORM);
    await first.intend('/w/.git/commondir', 200, COMMONDIR_FORM);
    await first.complete('/w/.git', { device: '1', inode: '2', born: '4', changed: '3' });
    expect((await createPlaceholderJournal(journalDirectory).records())).toEqual([
      { path: '/w/.git', intentMs: 100, form: DIRECTORY_FORM, identity: { device: '1', inode: '2', born: '4', changed: '3' } },
      { path: '/w/.git/commondir', intentMs: 200, form: COMMONDIR_FORM, identity: null },
    ]);
  });

  it('reads an intent written without a form as an empty file', async () => {
    await createPlaceholderJournal(journalDirectory).intend('/w/.envrc', 300);
    expect((await createPlaceholderJournal(journalDirectory).records())).toEqual([{ path: '/w/.envrc', intentMs: 300, form: EMPTY_FILE, identity: null }]);
  });

  it('reads a record written before forms existed as an empty file, and an identity without its change time as no identity', async () => {
    await createPlaceholderJournal(journalDirectory).records();
    fs.writeFileSync(path.join(journalDirectory, 'legacy.json'), JSON.stringify({ path: '/w/.mcp.json', intentMs: 5, identity: { device: '7', inode: '8', birthMs: 9 } }));
    expect((await createPlaceholderJournal(journalDirectory).records())).toEqual([
      { path: '/w/.mcp.json', intentMs: 5, form: EMPTY_FILE, identity: null },
    ]);
  });

  it('refuses a record whose form is malformed instead of guessing it', async () => {
    await createPlaceholderJournal(journalDirectory).records();
    fs.writeFileSync(path.join(journalDirectory, 'bad.json'), JSON.stringify({ path: '/w/.mcp.json', intentMs: 5, form: { kind: 'socket' }, identity: null }));
    await expect(createPlaceholderJournal(journalDirectory).records()).rejects.toThrow();
  });
});

describe('isStillThePlaceholder judges by form and identity', () => {
  const statAt = async (target: string, birthtimeNs: bigint): Promise<fs.BigIntStats> => {
    const real = await fs.promises.lstat(target, { bigint: true });
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { birthtimeNs }) as fs.BigIntStats;
  };

  it('refuses a directory at the same path and inode whose birth time differs: a new directory the kernel reused the inode of', async () => {
    const target = path.join(work, '.git');
    makeForm(target, DIRECTORY_FORM);
    const identity = await identityOf(target);
    const reborn = await statAt(target, (await fs.promises.lstat(target, { bigint: true })).birthtimeNs + 1n);
    expect(await isStillThePlaceholder(target, identity, DIRECTORY_FORM, async () => reborn)).toBe(false);
    expect(await isStillThePlaceholder(target, identity, DIRECTORY_FORM)).toBe(true);
  });

  it('refuses a file at the same path and inode whose birth time differs', async () => {
    const target = path.join(work, 'commondir');
    makeForm(target, COMMONDIR_FORM);
    const identity = await identityOf(target);
    const reborn = await statAt(target, (await fs.promises.lstat(target, { bigint: true })).birthtimeNs + 1n);
    expect(await isStillThePlaceholder(target, identity, COMMONDIR_FORM, async () => reborn)).toBe(false);
  });

  it('never takes a directory for the placeholder when the file system gave no birth time to record', async () => {
    const target = path.join(work, '.git');
    makeForm(target, DIRECTORY_FORM);
    const identity = { ...(await identityOf(target)), born: '0' };
    expect(await isStillThePlaceholder(target, identity, DIRECTORY_FORM)).toBe(false);
  });

  it('accepts a file with exactly the bytes of its form and its recorded identity', async () => {
    const target = path.join(work, 'commondir');
    makeForm(target, COMMONDIR_FORM);
    expect(await isStillThePlaceholder(target, await identityOf(target), COMMONDIR_FORM)).toBe(true);
  });

  it('accepts an empty directory with its recorded identity', async () => {
    const target = path.join(work, '.git');
    makeForm(target, DIRECTORY_FORM);
    expect(await isStillThePlaceholder(target, await identityOf(target), DIRECTORY_FORM)).toBe(true);
  });

  it('treats a call without a form as an empty file', async () => {
    const target = path.join(work, '.envrc');
    makeForm(target, EMPTY_FILE);
    expect(await isStillThePlaceholder(target, await identityOf(target))).toBe(true);
    expect(await isStillThePlaceholder(target, await identityOf(target), COMMONDIR_FORM)).toBe(false);
  });

  it('refuses a file whose bytes changed, also when only emptied or extended', async () => {
    const target = path.join(work, 'commondir');
    makeForm(target, COMMONDIR_FORM);
    const identity = await identityOf(target);
    for (const bytes of ['', '.', '.\n\n', '../main\n', ',\n']) {
      fs.writeFileSync(target, bytes);
      expect(await isStillThePlaceholder(target, identity, COMMONDIR_FORM)).toBe(false);
    }
  });

  it('refuses a directory that is no longer empty', async () => {
    const target = path.join(work, '.git');
    makeForm(target, DIRECTORY_FORM);
    const identity = await identityOf(target);
    fs.writeFileSync(path.join(target, 'HEAD'), 'ref: refs/heads/main\n');
    expect(await isStillThePlaceholder(target, identity, DIRECTORY_FORM)).toBe(false);
  });

  it('refuses a directory or a file that replaced the placeholder under another inode', async () => {
    const directory = path.join(work, '.git');
    makeForm(directory, DIRECTORY_FORM);
    const directoryIdentity = await identityOf(directory);
    fs.rmdirSync(directory);
    fs.mkdirSync(path.join(work, 'other'));
    fs.mkdirSync(directory);
    expect(await isStillThePlaceholder(directory, directoryIdentity, DIRECTORY_FORM)).toBe(false);
    const file = path.join(directory, 'commondir');
    makeForm(file, COMMONDIR_FORM);
    const fileIdentity = await identityOf(file);
    fs.rmSync(file);
    fs.writeFileSync(path.join(work, 'other-file'), '');
    makeForm(file, COMMONDIR_FORM);
    expect(await isStillThePlaceholder(file, fileIdentity, COMMONDIR_FORM)).toBe(false);
  });

  it('refuses a placeholder whose kind differs from its form', async () => {
    const directory = path.join(work, 'dir');
    makeForm(directory, DIRECTORY_FORM);
    expect(await isStillThePlaceholder(directory, await identityOf(directory), EMPTY_FILE)).toBe(false);
    const file = path.join(work, 'file');
    makeForm(file, EMPTY_FILE);
    expect(await isStillThePlaceholder(file, await identityOf(file), DIRECTORY_FORM)).toBe(false);
  });
});

describe('recovery at start removes a placeholder only in its form', () => {
  it('removes an empty directory and a commondir with exactly its bytes, both with their identity, and forgets them', async () => {
    const journal = createPlaceholderJournal(journalDirectory);
    const git = path.join(work, '.git');
    const commondir = path.join(work, 'sub-commondir');
    await journaled(journal, git, DIRECTORY_FORM);
    await journaled(journal, commondir, COMMONDIR_FORM);
    expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [git, commondir].sort(), kept: [], unrecovered: [] });
    expect(fs.existsSync(git)).toBe(false);
    expect(fs.existsSync(commondir)).toBe(false);
    expect((await journal.records())).toEqual([]);
  });

  it('leaves a directory placeholder while a live sandbox holds it, and keeps the record', async () => {
    const journal = createPlaceholderJournal(journalDirectory);
    const git = path.join(work, '.git');
    await journaled(journal, git, DIRECTORY_FORM);
    expect(await recoverPlaceholders(journal, { holders: () => new Set([git]) })).toEqual({ removed: [], kept: [git], unrecovered: [] });
    expect(fs.lstatSync(git).isDirectory()).toBe(true);
    expect((await journal.records())).toHaveLength(1);
  });

  it('leaves a directory that is no longer empty and a commondir whose bytes changed, and forgets them', async () => {
    const journal = createPlaceholderJournal(journalDirectory);
    const git = path.join(work, '.git');
    const commondir = path.join(work, 'sub-commondir');
    await journaled(journal, git, DIRECTORY_FORM);
    await journaled(journal, commondir, COMMONDIR_FORM);
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(commondir, '../main\n');
    expect(await recoverPlaceholders(journal, { holders: noHolders })).toEqual({ removed: [], kept: [], unrecovered: [] });
    expect(fs.readdirSync(git)).toEqual(['HEAD']);
    expect(fs.readFileSync(commondir, 'utf8')).toBe('../main\n');
    expect((await journal.records())).toEqual([]);
  });

  it('leaves an empty directory that replaced the placeholder under another inode', async () => {
    const journal = createPlaceholderJournal(journalDirectory);
    const git = path.join(work, '.git');
    await journaled(journal, git, DIRECTORY_FORM);
    fs.rmdirSync(git);
    fs.mkdirSync(path.join(work, 'other'));
    fs.mkdirSync(git);
    expect((await recoverPlaceholders(journal, { holders: noHolders })).removed).toEqual([]);
    expect(fs.lstatSync(git).isDirectory()).toBe(true);
    expect((await journal.records())).toEqual([]);
  });
});
