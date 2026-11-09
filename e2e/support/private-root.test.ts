import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { createProcessLedger } from './ledger.ts';
import { appendHarnessFile, createHarnessFile, currentIdentity, privateRootName, privateTempRoot, readHarnessFile } from './run-env.ts';
import { killListedGroups, runE2eTeardown } from './teardown.ts';

const RUN = 'ab12';
const VICTIM_TEXT = 'victim\n';

const victimIn = (context: CleanupContext): string => {
  const victim = path.join(withTempDir(context), 'victim');
  fs.writeFileSync(victim, VICTIM_TEXT, { mode: 0o600 });
  return victim;
};

const noOpPorts = {
  startTimeOf: async () => ({ kind: 'gone' as const }),
  groupAlive: () => false,
  pidAlive: () => false,
  killGroups: async () => undefined,
};

describe('the private e2e temp dir', () => {
  it('is created as mme-<uid> with mode 0700 inside the base when absent', (context) => {
    const base = withTempDir(context);
    const root = privateTempRoot(base);
    expect(root).toBe(path.join(base, privateRootName(currentIdentity())));
    expect(path.basename(root)).toBe(`mme-${process.getuid?.()}`);
    const stat = fs.lstatSync(root);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(privateTempRoot(base)).toBe(root);
  });

  it('refuses a pre-existing symlink at the private path and leaves its target untouched', (context) => {
    const base = withTempDir(context);
    const target = withTempDir(context);
    const root = path.join(base, privateRootName(currentIdentity()));
    fs.symlinkSync(target, root);
    expect(() => privateTempRoot(base)).toThrow(`e2e private temp dir ${root} is refused: it is a symbolic link`);
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('refuses a regular file at the private path', (context) => {
    const base = withTempDir(context);
    const root = path.join(base, privateRootName(currentIdentity()));
    fs.writeFileSync(root, '');
    expect(() => privateTempRoot(base)).toThrow(`e2e private temp dir ${root} is refused: it is not a directory`);
  });

  it('refuses a directory owned by the user that grants group or other bits, and never changes its mode', (context) => {
    for (const mode of [0o750, 0o705, 0o777]) {
      const base = withTempDir(context);
      const root = path.join(base, privateRootName(currentIdentity()));
      fs.mkdirSync(root);
      fs.chmodSync(root, mode);
      expect(() => privateTempRoot(base)).toThrow(new RegExp(`${root} is refused: its mode ${mode.toString(8)} grants group or other permissions`));
      expect(fs.lstatSync(root).mode & 0o777).toBe(mode);
    }
  });

  it('refuses a directory owned by another uid', (context) => {
    const base = withTempDir(context);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('this platform reports no uid');
    const other = { uid: uid + 1 };
    const root = path.join(base, privateRootName(other));
    fs.mkdirSync(root, { mode: 0o700 });
    expect(() => privateTempRoot(base, other)).toThrow(`e2e private temp dir ${root} is refused: it is owned by uid ${uid}, not by uid ${uid + 1}`);
  });

  it('without a uid, still refuses a symlink and names the directory mme-user', (context) => {
    const base = withTempDir(context);
    const root = path.join(base, 'mme-user');
    fs.symlinkSync(withTempDir(context), root);
    expect(() => privateTempRoot(base, { uid: undefined })).toThrow(`${root} is refused: it is a symbolic link`);
  });
});

describe('harness files', () => {
  it('a harness file that already exists is neither followed nor overwritten on create', (context) => {
    const dir = withTempDir(context);
    const victim = victimIn(context);
    const linked = path.join(dir, `mme-${RUN}-live`);
    fs.symlinkSync(victim, linked);
    expect(() => createHarnessFile(linked, '123')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    const regular = path.join(dir, `mme-${RUN}-other`);
    fs.writeFileSync(regular, 'existing');
    expect(() => createHarnessFile(regular, '123')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readFileSync(regular, 'utf8')).toBe('existing');
    expect(fs.readFileSync(victim, 'utf8')).toBe(VICTIM_TEXT);
  });

  it('a symlink at the pids path is neither followed on append nor on read', async (context) => {
    const dir = withTempDir(context);
    const victim = victimIn(context);
    const pidsFile = path.join(dir, `mme-${RUN}-pids`);
    fs.symlinkSync(victim, pidsFile);
    expect(() => appendHarnessFile(pidsFile, '1\n')).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    expect(() => readHarnessFile(pidsFile)).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    await expect(createProcessLedger({ pidsFile, ports: noOpPorts }).add(process.pid, 'supervisor')).rejects.toThrow(expect.objectContaining({ code: 'ELOOP' }));
    await expect(killListedGroups(pidsFile, noOpPorts)).rejects.toThrow(expect.objectContaining({ code: 'ELOOP' }));
    expect(fs.readFileSync(victim, 'utf8')).toBe(VICTIM_TEXT);
  });

  it('appends to an existing regular pids file without truncating it, and creates it with mode 0600', (context) => {
    const dir = withTempDir(context);
    const pidsFile = path.join(dir, `mme-${RUN}-pids`);
    appendHarnessFile(pidsFile, 'a\n');
    appendHarnessFile(pidsFile, 'b\n');
    expect(fs.readFileSync(pidsFile, 'utf8')).toBe('a\nb\n');
    expect(fs.statSync(pidsFile).mode & 0o777).toBe(0o600);
  });
});

describe('the e2e teardown sweep', () => {
  it('removes only entries of the run inside the private dir and never touches an entry outside it', async (context) => {
    const sharedBase = withTempDir(context);
    const tmpRoot = privateTempRoot(sharedBase);
    const inside = path.join(tmpRoot, `mme-${RUN}-aaaaaa`);
    fs.mkdirSync(inside, { mode: 0o700 });
    const outside = path.join(sharedBase, `mme-${RUN}-bbbbbb`);
    fs.mkdirSync(outside, { mode: 0o700 });
    const outsideTestkit = path.join(sharedBase, `mmt-${RUN}-cccccc`);
    fs.mkdirSync(outsideTestkit, { mode: 0o700 });
    const reports: string[] = [];
    await expect(runE2eTeardown({ tmpRoot, run: RUN, evalBase: withTempDir(context), sharedBase, ports: noOpPorts, report: (line) => reports.push(line) })).rejects.toThrow(
      'e2e leak guard: run ab12 left 0 process group(s) and 2 director(ies)',
    );
    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(outsideTestkit)).toBe(true);
    expect(reports).toContain(`e2e teardown: leaked directory ${inside}`);
    expect(reports).toContain(`e2e teardown: leaked testkit directory ${outsideTestkit}, left in place outside the private e2e directory`);
    expect(reports.some((line) => line.includes(outside))).toBe(false);
  });
});
