import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_PROGRAM_ENV, SECRET_STORE_SEARCHED_PROGRAMS, findProgramOnPath, secretStoreEnvFor } from '@momonga/foundation';

const SCRIPT = path.join(import.meta.dirname, 'fake-secret-programs.ts');

const runScript = (...args: string[]): string => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('scripts/fake-secret-programs.ts', () => {
  it('installs every backend program as a fake in a fresh private directory, prints it and the PATH prefix, and removes it again', () => {
    const [directory, prefix, ...rest] = runScript('install').split('\n');
    expect(rest).toEqual(['']);
    expect(fs.statSync(directory as string).mode & 0o777).toBe(0o700);
    const match = /^PATH=(.+):\$PATH$/.exec(prefix as string);
    expect(match).not.toBeNull();
    const bin = (match as RegExpExecArray)[1] as string;
    expect(path.dirname(bin)).toBe(directory);
    const env = { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` };
    for (const program of SECRET_STORE_SEARCHED_PROGRAMS) expect(findProgramOnPath(program, env)).toBe(path.join(bin, program));
    expect(secretStoreEnvFor(env)[SECRET_PROGRAM_ENV]).toBe(path.join(bin, 'security'));
    expect(runScript('remove', directory as string)).toBe('');
    expect(fs.existsSync(directory as string)).toBe(false);
  });

  it('refuses to remove a directory it did not install', () => {
    const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'not-fake-'));
    try {
      expect(() => execFileSync(process.execPath, [SCRIPT, 'remove', other], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/is not a fake secret programs directory/);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
