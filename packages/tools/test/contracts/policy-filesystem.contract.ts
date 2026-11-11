import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ProgramResolution, WritableCheck } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';

export type PolicyFilesystemSubject = {
  resolveProgram(name: string, cwd: string, searchPath: string | undefined, isWritable: WritableCheck): Promise<ProgramResolution>;
  expandGlob(pattern: string, cwd: string, limit: number): Promise<unknown>;
};

export type ContractDisk = { held: readonly string[] };

export type GlobAnswer = { kind: 'expanded' } | { kind: 'refused'; error: new (...args: never[]) => Error };

const SYSTEM_LS = '/bin/ls';

const programIn = (directory: string, name: string): string => {
  const file = path.join(directory, name);
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
};

const folderIn = (root: string, name: string): string => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  return directory;
};

export const policyFilesystemContract = (make: (disk: ContractDisk) => PolicyFilesystemSubject, undeclaredGlob: GlobAnswer): void => {
  it('resolves a system program named exactly on the search path', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    expect(await make({ held: [SYSTEM_LS] }).resolveProgram('ls', root, '/bin', () => false)).toEqual({ program: SYSTEM_LS });
  });

  it('resolves none for a system program that a writable entry before it shadows', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    const writable = folderIn(root, 'writable');
    const shadow = programIn(writable, 'ls');
    expect(await make({ held: [shadow, SYSTEM_LS] }).resolveProgram('ls', root, `${writable}:/bin`, (entry) => entry === writable)).toEqual({ none: true });
  });

  it('resolves a program that only a writable entry holds', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    const writable = folderIn(root, 'writable');
    const tool = programIn(writable, 'mm-contract-tool');
    expect(await make({ held: [tool] }).resolveProgram('mm-contract-tool', root, `${writable}:/bin`, (entry) => entry === writable)).toEqual({ program: tool });
  });

  it('resolves none for a system program behind a relative entry that holds it', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    const local = folderIn(root, 'local');
    const shadow = programIn(local, 'ls');
    expect(await make({ held: [shadow, SYSTEM_LS] }).resolveProgram('ls', root, 'local:/bin', () => false)).toEqual({ none: true });
  });

  it('resolves none without a search path', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    expect(await make({ held: [SYSTEM_LS] }).resolveProgram('ls', root, undefined, () => false)).toEqual({ none: true });
  });

  it(`answers a glob no test declared: ${undeclaredGlob.kind === 'expanded' ? 'expanded from the disk' : 'refused, since only bash on the disk can expand it'}`, async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    fs.writeFileSync(path.join(root, 'a.txt'), '');
    const expansion = make({ held: [] }).expandGlob('*.txt', root, 10);
    if (undeclaredGlob.kind === 'expanded') expect(await expansion).toEqual({ matches: ['a.txt'] });
    else await expect(expansion).rejects.toBeInstanceOf(undeclaredGlob.error);
  });
};
