import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_STORE_SEARCHED_PROGRAMS } from '@momonga/foundation';
import { runFakeSecretPrograms } from './fake-secret-programs.ts';

const SCRIPT = path.join(import.meta.dirname, 'fake-secret-programs.ts');

const runScript = (args: readonly string[], env: NodeJS.ProcessEnv = process.env): string => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });

const refusalOf = (args: readonly string[]): string => {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    return String((error as { stderr: string }).stderr);
  }
  throw new Error(`fake-secret-programs.ts ${args.join(' ')} succeeded`);
};

const resolvedThroughShell = (pathLine: string, env: NodeJS.ProcessEnv): string[] =>
  execFileSync('/bin/sh', ['-c', `${pathLine}; export PATH; for p in ${SECRET_STORE_SEARCHED_PROGRAMS.join(' ')}; do command -v "$p"; done`], { encoding: 'utf8', env }).trim().split('\n');

describe('scripts/fake-secret-programs.ts', () => {
  it('installs every backend program as a fake in a fresh private directory, prints it and a POSIX shell PATH line, and removes it again', () => {
    const [directory, pathLine, ...rest] = runScript(['install']).split('\n') as [string, string, ...string[]];
    expect(rest).toEqual(['']);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(pathLine).toBe(`PATH='${path.join(directory, 'bin')}':"$PATH"`);
    expect(resolvedThroughShell(pathLine, process.env)).toEqual(SECRET_STORE_SEARCHED_PROGRAMS.map((program) => path.join(directory, 'bin', program)));
    expect(runScript(['remove', directory])).toBe('');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('prints a PATH line that a POSIX shell evaluates correctly when the temp directory holds a space', () => {
    const spaced = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'with space '));
    try {
      const env = { ...process.env, TMPDIR: spaced };
      const [directory, pathLine] = runScript(['install'], env).split('\n') as [string, string];
      expect(directory.startsWith(`${spaced}${path.sep}`)).toBe(true);
      expect(resolvedThroughShell(pathLine, process.env)).toEqual(SECRET_STORE_SEARCHED_PROGRAMS.map((program) => path.join(directory, 'bin', program)));
      expect(runScript(['remove', directory], env)).toBe('');
    } finally {
      fs.rmSync(spaced, { recursive: true, force: true });
    }
  });

  it('refuses to remove a directory it did not install', () => {
    const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'not-fake-'));
    try {
      expect(refusalOf(['remove', other])).toMatch(/is not a fake secret programs directory/);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a look-alike with the same name and subdirectories and an extra file, and leaves it intact', () => {
    const [directory] = runScript(['install']).split('\n') as [string];
    const lookAlike = `${directory}-look-alike`;
    try {
      fs.mkdirSync(path.join(lookAlike, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(lookAlike, 'items'));
      fs.writeFileSync(path.join(lookAlike, 'notes.txt'), 'keep me');
      expect(refusalOf(['remove', lookAlike])).toMatch(/is not a fake secret programs directory/);
      expect(fs.readFileSync(path.join(lookAlike, 'notes.txt'), 'utf8')).toBe('keep me');
      fs.writeFileSync(path.join(directory, 'extra.txt'), 'extra');
      expect(refusalOf(['remove', directory])).toMatch(/is not a fake secret programs directory/);
      expect(fs.existsSync(path.join(directory, 'bin'))).toBe(true);
    } finally {
      fs.rmSync(lookAlike, { recursive: true, force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('on Windows refuses with one sentence, because no fake the product can start exists there yet', () => {
    const errors: string[] = [];
    const code = runFakeSecretPrograms(['install'], 'win32', { out: () => undefined, err: (text) => errors.push(text) });
    expect(code).toBe(1);
    expect(errors.join('')).toBe('fake-secret-programs.ts: no fake secret store program that the product can start exists for Windows yet.\n');
  });
});
