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

const tempDir = (prefix: string): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const binDirWith = (...programs: string[]): string => {
  const dir = tempDir('mm-open-bin-');
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

  it('uses rundll32 with url.dll,FileProtocolHandler found on PATH', () => {
    const bin = binDirWith('rundll32');
    expect(openCommandFor(URL_TO_OPEN, { PATH: bin })).toEqual({
      file: path.join(bin, 'rundll32'),
      args: ['url.dll,FileProtocolHandler', URL_TO_OPEN.toString()],
    });
  });

  it('prefers xdg-open over open, and open over rundll32, in the same PATH entry', () => {
    expect(openCommandFor(URL_TO_OPEN, { PATH: binDirWith('open', 'xdg-open', 'rundll32') }).file).toMatch(/xdg-open$/);
    expect(openCommandFor(URL_TO_OPEN, { PATH: binDirWith('rundll32', 'open') }).file).toMatch(/[\\/]open$/);
  });

  it('prefers the program order over the PATH entry order', () => {
    const first = binDirWith('open');
    const second = binDirWith('xdg-open');
    expect(openCommandFor(URL_TO_OPEN, { PATH: [first, second].join(path.delimiter) }).file).toBe(path.join(second, 'xdg-open'));
  });

  it('searches every PATH entry in order', () => {
    const empty = binDirWith();
    const bin = binDirWith('xdg-open');
    expect(openCommandFor(URL_TO_OPEN, { PATH: [empty, bin].join(path.delimiter) }).file).toBe(path.join(bin, 'xdg-open'));
  });

  it('uses BROWSER first when the user set it, ahead of a program on PATH', () => {
    const bin = binDirWith('xdg-open');
    const browser = path.join(binDirWith('my-browser'), 'my-browser');
    expect(openCommandFor(URL_TO_OPEN, { PATH: bin, BROWSER: browser })).toEqual({ file: browser, args: [URL_TO_OPEN.toString()] });
  });

  it('ignores an empty BROWSER', () => {
    const bin = binDirWith('xdg-open');
    expect(openCommandFor(URL_TO_OPEN, { PATH: bin, BROWSER: '' }).file).toBe(path.join(bin, 'xdg-open'));
  });

  it('skips a file of that name that is not executable', () => {
    const bin = binDirWith();
    fs.writeFileSync(path.join(bin, 'xdg-open'), 'not a program', { mode: 0o644 });
    expect(() => openCommandFor(URL_TO_OPEN, { PATH: bin })).toThrow('xdg-open');
  });

  it('names every program it looked for when none is on PATH', () => {
    const bin = binDirWith();
    const error = (() => {
      try {
        openCommandFor(URL_TO_OPEN, { PATH: bin });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('xdg-open');
    expect(message).toMatch(/(^|[^-])open/);
    expect(message).toContain('rundll32');
  });

  it('never uses cmd /c start', () => {
    const bin = binDirWith('cmd', 'start');
    expect(() => openCommandFor(URL_TO_OPEN, { PATH: bin })).toThrow();
  });
});
