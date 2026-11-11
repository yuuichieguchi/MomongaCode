import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProgramOnPath, nodeFileSystem, openCommandFor } from '@momonga/foundation';

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

type ProgramSearchFiles = Parameters<typeof findProgramOnPath>[2];

const commandOn = (env: Record<string, string>) => openCommandFor(URL_TO_OPEN, env, nodeFileSystem);

const everyFileAProgram = () => {
  const asked: string[] = [];
  const files: ProgramSearchFiles = {
    stat: async (file) => {
      asked.push(file);
      return { isFile: () => true } as fs.Stats;
    },
    access: async () => undefined,
  };
  return { files, asked };
};

describe('open command found by PATH search (B14)', () => {
  it('uses open found on PATH', async () => {
    const bin = binDirWith('open');
    expect(await commandOn({ PATH: bin })).toEqual({ file: path.join(bin, 'open'), args: [URL_TO_OPEN.toString()] });
  });

  it('uses xdg-open found on PATH', async () => {
    const bin = binDirWith('xdg-open');
    expect(await commandOn({ PATH: bin })).toEqual({ file: path.join(bin, 'xdg-open'), args: [URL_TO_OPEN.toString()] });
  });

  it('uses rundll32 with url.dll,FileProtocolHandler found on PATH', async () => {
    const bin = binDirWith('rundll32');
    expect(await commandOn({ PATH: bin })).toEqual({
      file: path.join(bin, 'rundll32'),
      args: ['url.dll,FileProtocolHandler', URL_TO_OPEN.toString()],
    });
  });

  it('prefers xdg-open over open, and open over rundll32, in the same PATH entry', async () => {
    expect((await commandOn({ PATH: binDirWith('open', 'xdg-open', 'rundll32') })).file).toMatch(/xdg-open$/);
    expect((await commandOn({ PATH: binDirWith('rundll32', 'open') })).file).toMatch(/[\\/]open$/);
  });

  it('prefers the program order over the PATH entry order', async () => {
    const first = binDirWith('open');
    const second = binDirWith('xdg-open');
    expect((await commandOn({ PATH: [first, second].join(path.delimiter) })).file).toBe(path.join(second, 'xdg-open'));
  });

  it('searches every PATH entry in order', async () => {
    const empty = binDirWith();
    const bin = binDirWith('xdg-open');
    expect((await commandOn({ PATH: [empty, bin].join(path.delimiter) })).file).toBe(path.join(bin, 'xdg-open'));
  });

  it('uses BROWSER first when the user set it, ahead of a program on PATH', async () => {
    const bin = binDirWith('xdg-open');
    const browser = path.join(binDirWith('my-browser'), 'my-browser');
    expect(await commandOn({ PATH: bin, BROWSER: browser })).toEqual({ file: browser, args: [URL_TO_OPEN.toString()] });
  });

  it('ignores an empty BROWSER', async () => {
    const bin = binDirWith('xdg-open');
    expect((await commandOn({ PATH: bin, BROWSER: '' })).file).toBe(path.join(bin, 'xdg-open'));
  });

  it('skips a file of that name that is not executable', async () => {
    const bin = binDirWith();
    fs.writeFileSync(path.join(bin, 'xdg-open'), 'not a program', { mode: 0o644 });
    await expect(commandOn({ PATH: bin })).rejects.toThrow('xdg-open');
  });

  it('names every program it looked for when none is on PATH', async () => {
    const error: unknown = await commandOn({ PATH: binDirWith() }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('xdg-open');
    expect(message).toMatch(/(^|[^-])open/);
    expect(message).toContain('rundll32');
  });

  it('never uses cmd /c start', async () => {
    await expect(commandOn({ PATH: binDirWith('cmd', 'start') })).rejects.toThrow();
  });
});

describe('the program search asks the file-system port and never resolves a program from the current folder (C34)', () => {
  it('a relative PATH entry is never searched, so a program in the current folder is never the match', async () => {
    const { files, asked } = everyFileAProgram();
    const absolute = path.resolve(path.sep, 'opt', 'stand-ins');
    const found = await findProgramOnPath('xdg-open', { PATH: ['.', 'bin', `.${path.sep}tools`, absolute].join(path.delimiter) }, files);
    expect(found).toBe(path.join(absolute, 'xdg-open'));
    expect(asked).toEqual([path.join(absolute, 'xdg-open')]);
  });

  it('the opener command is found through the port it is given', async () => {
    const { files, asked } = everyFileAProgram();
    const absolute = path.resolve(path.sep, 'opt', 'stand-ins');
    expect(await openCommandFor(URL_TO_OPEN, { PATH: absolute }, files)).toEqual({ file: path.join(absolute, 'xdg-open'), args: [URL_TO_OPEN.toString()] });
    expect(asked).toEqual([path.join(absolute, 'xdg-open')]);
  });

  it('a file-system failure that is not a missing program is not taken for a missing program', async () => {
    const files: ProgramSearchFiles = {
      stat: async () => {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      },
      access: async () => undefined,
    };
    await expect(findProgramOnPath('xdg-open', { PATH: path.resolve(path.sep, 'opt') }, files)).rejects.toThrow('EIO');
  });
});
