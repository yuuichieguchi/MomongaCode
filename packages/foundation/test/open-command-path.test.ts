import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCommandFor } from '@momonga/foundation';

const URL_TO_OPEN = new URL('https://auth.example.com/authorize?client_id=a&state=b');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const binDirWith = (...programs: string[]): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-open-bin-')));
  tempDirs.push(dir);
  for (const program of programs) fs.writeFileSync(path.join(dir, program), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
};

describe('open command found by PATH search (B14)', () => {
  it('uses open found on PATH', () => {
    const bin = binDirWith('open');
    expect(openCommandFor(URL_TO_OPEN, { PATH: bin })).toEqual({ file: path.join(bin, 'open'), args: [URL_TO_OPEN.toString()] });
  });

  it('uses xdg-open found on PATH', () => {
    const bin = binDirWith('xdg-open');
    expect(openCommandFor(URL_TO_OPEN, { PATH: bin })).toEqual({ file: path.join(bin, 'xdg-open'), args: [URL_TO_OPEN.toString()] });
  });

  it('searches every PATH entry in order', () => {
    const empty = binDirWith();
    const bin = binDirWith('xdg-open');
    expect(openCommandFor(URL_TO_OPEN, { PATH: [empty, bin].join(path.delimiter) }).file).toBe(path.join(bin, 'xdg-open'));
  });

  it('skips a file of that name that is not executable', () => {
    const bin = binDirWith();
    fs.writeFileSync(path.join(bin, 'xdg-open'), 'not a program', { mode: 0o644 });
    expect(() => openCommandFor(URL_TO_OPEN, { PATH: bin })).toThrow('xdg-open');
  });

  it('names every program it looked for when none is on PATH', () => {
    const bin = binDirWith();
    expect(() => openCommandFor(URL_TO_OPEN, { PATH: bin })).toThrow(/open.*xdg-open|xdg-open.*open/);
  });
});
