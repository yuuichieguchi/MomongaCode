import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_STORE_SEARCHED_PROGRAMS, URL_OPENER_PROGRAMS } from '@momonga/foundation';
import { TEST_SECRET_PROGRAMS_ENV } from '@momonga/testkit';
import globalSetup from '../test/support/fake-secret-programs.ts';
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

const INSTALLED_PROGRAMS = [...SECRET_STORE_SEARCHED_PROGRAMS, ...URL_OPENER_PROGRAMS];

const resolvedThroughShell = (envLine: string, env: NodeJS.ProcessEnv): string[] =>
  execFileSync('/bin/sh', ['-c', `${envLine}; for p in ${INSTALLED_PROGRAMS.join(' ')}; do command -v "$p"; done; '${process.execPath}' -p 'process.env.BROWSER'`], { encoding: 'utf8', env }).trim().split('\n');

const resolvedIn = (directory: string): string[] => [...INSTALLED_PROGRAMS.map((program) => path.join(directory, 'bin', program)), path.join(directory, 'bin', 'browser')];

describe('scripts/fake-secret-programs.ts', () => {
  it('installs every secret store program and every program that opens a URL as a stand-in in a fresh private directory, prints it and one POSIX shell line that sets and exports PATH and BROWSER, and removes it again', () => {
    const [directory, pathLine, token, ...rest] = runScript(['install']).split('\n') as [string, string, string, ...string[]];
    expect(rest).toEqual(['']);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(pathLine).toBe(`PATH='${path.join(directory, 'bin')}':"$PATH" BROWSER='${path.join(directory, 'bin', 'browser')}'; export PATH BROWSER`);
    expect(resolvedThroughShell(pathLine, { PATH: '/usr/bin:/bin' })).toEqual(resolvedIn(directory));
    expect(refusalOf(['remove', directory])).toMatch(/usage:/);
    expect(refusalOf(['remove', directory, 'f'.repeat(64)])).toMatch(/is not a fake programs directory this token created/);
    expect(fs.existsSync(path.join(directory, 'bin'))).toBe(true);
    expect(runScript(['remove', directory, token])).toBe('');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('prints a PATH line that a POSIX shell evaluates correctly when the temp directory holds a space', () => {
    const spaced = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'with space '));
    try {
      const env = { ...process.env, TMPDIR: spaced };
      const [directory, pathLine, token] = runScript(['install'], env).split('\n') as [string, string, string];
      expect(directory.startsWith(`${spaced}${path.sep}`)).toBe(true);
      expect(resolvedThroughShell(pathLine, { PATH: '/usr/bin:/bin' })).toEqual(resolvedIn(directory));
      expect(runScript(['remove', directory, token], env)).toBe('');
    } finally {
      fs.rmSync(spaced, { recursive: true, force: true });
    }
  });

  it('refuses to remove a directory it did not install', () => {
    const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'not-fake-'));
    try {
      expect(refusalOf(['remove', other, 'f'.repeat(64)])).toMatch(/is not a fake programs directory this token created/);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a hand-made look-alike with a well-formed marker, whatever token is given, and leaves it intact', () => {
    const lookAlike = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'momonga-secret-programs-')));
    const forged = 'a'.repeat(64);
    try {
      fs.mkdirSync(path.join(lookAlike, 'bin'));
      fs.mkdirSync(path.join(lookAlike, 'items'));
      fs.writeFileSync(path.join(lookAlike, 'items', 'kept'), 'keep me');
      fs.writeFileSync(path.join(lookAlike, '.momonga-fake-secret-programs'), JSON.stringify({ token: forged, root: lookAlike }));
      expect(refusalOf(['remove', lookAlike])).toMatch(/usage:/);
      expect(refusalOf(['remove', lookAlike, 'b'.repeat(64)])).toMatch(/is not a fake programs directory this token created/);
      expect(refusalOf(['remove', lookAlike, ''])).toMatch(/is not a fake programs directory this token created/);
      expect(fs.readFileSync(path.join(lookAlike, 'items', 'kept'), 'utf8')).toBe('keep me');
    } finally {
      fs.rmSync(lookAlike, { recursive: true, force: true });
    }
  });

  it('refuses the real directory once it holds an extra file, even with its token', () => {
    const [directory, , token] = runScript(['install']).split('\n') as [string, string, string];
    try {
      fs.writeFileSync(path.join(directory, 'extra.txt'), 'extra');
      expect(refusalOf(['remove', directory, token])).toMatch(/is not a fake programs directory this token created/);
      expect(fs.existsSync(path.join(directory, 'bin'))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('the global setup of a test run removes its directory with the token it kept in memory', async () => {
    const before = process.env['PATH'];
    const beforeBin = process.env[TEST_SECRET_PROGRAMS_ENV];
    const beforeBrowser = process.env['BROWSER'];
    try {
      const teardown = globalSetup();
      const bin = process.env[TEST_SECRET_PROGRAMS_ENV] as string;
      expect(fs.existsSync(bin)).toBe(true);
      expect(process.env['PATH']?.split(path.delimiter)[0]).toBe(bin);
      expect(process.env['BROWSER']).toBe(path.join(bin, 'browser'));
      teardown();
      expect(fs.existsSync(path.dirname(bin))).toBe(false);
    } finally {
      process.env['PATH'] = before;
      process.env[TEST_SECRET_PROGRAMS_ENV] = beforeBin;
      process.env['BROWSER'] = beforeBrowser;
    }
  });

  it('on Windows refuses with one sentence, because no fake the product can start exists there yet', () => {
    const errors: string[] = [];
    const code = runFakeSecretPrograms(['install'], 'win32', { out: () => undefined, err: (text) => errors.push(text) });
    expect(code).toBe(1);
    expect(errors.join('')).toBe('fake-secret-programs.ts: no fake secret store program that the product can start exists for Windows yet.\n');
  });
});
