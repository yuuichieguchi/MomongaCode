import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserOpener, openCommandFor } from '@momonga/foundation';

const URL_TO_OPEN = new URL('https://auth.example.com/authorize?client_id=a&state=b');
const SIGNAL = new AbortController().signal;

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

type RecordedOpen = { file: string; args: readonly string[] };

const recordingOpener = (env: Record<string, string | undefined>, exitCode = 0) => {
  const events: string[] = [];
  const runs: RecordedOpen[] = [];
  const open = createBrowserOpener({
    env,
    print: (text: string) => {
      events.push(`print:${text}`);
    },
    run: async (file: string, args: readonly string[]) => {
      events.push(`run:${file}`);
      runs.push({ file, args });
      return { exitCode };
    },
  });
  return { open, events, runs };
};

describe('browser opener prints the URL first and never fails on an open it could not make (B14)', () => {
  it('prints the URL before the opener runs, then runs the PATH program with the URL', async () => {
    const bin = binDirWith('xdg-open');
    const { open, events, runs } = recordingOpener({ PATH: bin });
    await open(URL_TO_OPEN, SIGNAL);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^print:/);
    expect(events[0]).toContain(URL_TO_OPEN.toString());
    expect(events[1]).toBe(`run:${path.join(bin, 'xdg-open')}`);
    expect(runs).toEqual([{ file: path.join(bin, 'xdg-open'), args: [URL_TO_OPEN.toString()] }]);
  });

  it('runs BROWSER and not the program on PATH when BROWSER is set', async () => {
    const bin = binDirWith('xdg-open');
    const browser = path.join(binDirWith('my-browser'), 'my-browser');
    const { open, runs } = recordingOpener({ PATH: bin, BROWSER: browser });
    await open(URL_TO_OPEN, SIGNAL);
    expect(runs).toEqual([{ file: browser, args: [URL_TO_OPEN.toString()] }]);
  });

  it('resolves with the URL printed and runs nothing when no opener is on PATH', async () => {
    const { open, events, runs } = recordingOpener({ PATH: binDirWith() });
    await expect(open(URL_TO_OPEN, SIGNAL)).resolves.toBeUndefined();
    expect(runs).toEqual([]);
    expect(events.join('\n')).toContain(URL_TO_OPEN.toString());
  });

  it('resolves with the URL printed when the opener exits with a failure', async () => {
    const bin = binDirWith('xdg-open');
    const { open, events, runs } = recordingOpener({ PATH: bin }, 1);
    await expect(open(URL_TO_OPEN, SIGNAL)).resolves.toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(events[0]).toContain(URL_TO_OPEN.toString());
  });

  it('resolves with the URL printed when the run port throws', async () => {
    const bin = binDirWith('open');
    const printed: string[] = [];
    const open = createBrowserOpener({
      env: { PATH: bin },
      print: (text: string) => {
        printed.push(text);
      },
      run: async () => {
        throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      },
    });
    await expect(open(URL_TO_OPEN, SIGNAL)).resolves.toBeUndefined();
    expect(printed.join('\n')).toContain(URL_TO_OPEN.toString());
  });

  it('does not run cmd or start found on PATH', async () => {
    const { open, runs } = recordingOpener({ PATH: binDirWith('cmd', 'start') });
    await open(URL_TO_OPEN, SIGNAL);
    expect(runs).toEqual([]);
  });
});
