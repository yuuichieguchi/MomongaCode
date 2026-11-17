import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserOpener, nodeFileSystem } from '@momonga/foundation';
import type { LaunchProgram, ProgramEnd } from '@momonga/foundation';
import { afterMicrotasks, createTempDir } from '@momonga/testkit';

const URL_TO_OPEN = new URL('https://auth.example.com/authorize?client_id=a&state=b');

const NO_OPENER_MESSAGE = 'no program to open a URL was found on PATH; looked for xdg-open, open, rundll32, and BROWSER is not set';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const binDirWith = (...programs: string[]): string => {
  const dir = createTempDir();
  tempDirs.push(dir);
  for (const program of programs) fs.writeFileSync(path.join(dir, program), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
};

type Launch = { file: string; args: readonly string[]; end: Promise<ProgramEnd> };

const scriptedLaunch = (endOf: () => Promise<ProgramEnd>) => {
  const launches: Launch[] = [];
  const launch: LaunchProgram = (file, args) => {
    const end = endOf();
    launches.push({ file, args, end });
    return end;
  };
  return { launch, launches };
};

const settledOf = async (promise: Promise<unknown>): Promise<void> => {
  await promise.then(
    () => undefined,
    () => undefined,
  );
  await afterMicrotasks();
};

const deferredEnd = () => {
  let settle: { resolve(end: ProgramEnd): void; reject(error: Error): void } = { resolve: () => undefined, reject: () => undefined };
  const end = new Promise<ProgramEnd>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { end, ...settle };
};

const never = (): Promise<ProgramEnd> => new Promise<ProgramEnd>(() => undefined);

describe('P-C7: the opener starts the program, never waits for it, and reports a failed launch', () => {
  it('starts the PATH program with the URL and returns at once', async () => {
    const bin = binDirWith('xdg-open');
    const { launch, launches } = scriptedLaunch(never);
    const calls: string[] = [];
    const returned = createBrowserOpener({ env: { PATH: bin }, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, (message) => calls.push(message));
    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(launches.map(({ file, args }) => ({ file, args }))).toEqual([{ file: path.join(bin, 'xdg-open'), args: [URL_TO_OPEN.toString()] }]));
    expect(calls).toEqual([]);
  });

  it('a start error is reported once, after openUrl returned', async () => {
    const bin = binDirWith('xdg-open');
    const file = path.join(bin, 'xdg-open');
    const { launch } = scriptedLaunch(() => Promise.reject(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
    const calls: string[] = [];
    createBrowserOpener({ env: { PATH: bin }, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, (message) => calls.push(message));
    expect(calls).toEqual([]);
    await vi.waitFor(() => expect(calls).toEqual([`${file} could not be started: spawn EACCES`]));
  });

  it('no opener on PATH reports the existing message and launches nothing', async () => {
    const { launch, launches } = scriptedLaunch(never);
    const calls: string[] = [];
    createBrowserOpener({ env: { PATH: binDirWith() }, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, (message) => calls.push(message));
    expect(calls).toEqual([]);
    await vi.waitFor(() => expect(calls).toEqual([NO_OPENER_MESSAGE]));
    expect(launches).toEqual([]);
  });

  it('an unsuccessful end while the caller still waits is reported', async () => {
    const bin = binDirWith('xdg-open');
    const file = path.join(bin, 'xdg-open');
    const exited = deferredEnd();
    const signalled = deferredEnd();
    const ends = [exited.end, signalled.end];
    const { launch, launches } = scriptedLaunch(() => ends.shift() ?? never());
    const open = createBrowserOpener({ env: { PATH: bin }, launch, files: nodeFileSystem });
    const exitedCalls: string[] = [];
    const signalledCalls: string[] = [];
    open(URL_TO_OPEN, new AbortController().signal, (message) => exitedCalls.push(message));
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    open(URL_TO_OPEN, new AbortController().signal, (message) => signalledCalls.push(message));
    exited.resolve({ exitCode: 3, signal: null });
    signalled.resolve({ exitCode: null, signal: 'SIGTERM' });
    await vi.waitFor(() => expect(exitedCalls).toEqual([`${file} exited with code 3`]));
    await vi.waitFor(() => expect(signalledCalls).toEqual([`${file} was ended by signal SIGTERM`]));
  });

  it('an exit with code 0 is silent', async () => {
    const bin = binDirWith('xdg-open');
    const { launch, launches } = scriptedLaunch(() => Promise.resolve({ exitCode: 0, signal: null }));
    const calls: string[] = [];
    createBrowserOpener({ env: { PATH: bin }, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, (message) => calls.push(message));
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    await settledOf(launches[0]!.end);
    expect(calls).toEqual([]);
  });

  it('nothing is reported after the watch signal aborted', async () => {
    const bin = binDirWith('xdg-open');
    const later = deferredEnd();
    const { launch, launches } = scriptedLaunch(() => later.end);
    const watch = new AbortController();
    const calls: string[] = [];
    createBrowserOpener({ env: { PATH: bin }, launch, files: nodeFileSystem })(URL_TO_OPEN, watch.signal, (message) => calls.push(message));
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    watch.abort();
    later.resolve({ exitCode: 1, signal: null });
    await settledOf(later.end);
    expect(calls).toEqual([]);
  });

  it('with the watch already aborted it searches nothing, starts nothing and reports nothing', async () => {
    const bin = binDirWith('xdg-open');
    const { launch, launches } = scriptedLaunch(() => Promise.resolve({ exitCode: 1, signal: null }));
    const searched: string[] = [];
    const files = { stat: (file: string) => (searched.push(file), nodeFileSystem.stat(file)), access: nodeFileSystem.access };
    const calls: string[] = [];
    createBrowserOpener({ env: { PATH: bin }, launch, files })(URL_TO_OPEN, AbortSignal.abort(), (message) => calls.push(message));
    await afterMicrotasks();
    await afterMicrotasks();
    expect(searched).toEqual([]);
    expect(launches).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'mailto:ada@example.com', 'ftp://example.com/x'])('refuses %s: only http and https are opened, nothing is started', async (address) => {
    const bin = binDirWith('xdg-open');
    const { launch, launches } = scriptedLaunch(never);
    const calls: string[] = [];
    createBrowserOpener({ env: { PATH: bin, BROWSER: path.join(bin, 'xdg-open') }, launch, files: nodeFileSystem })(new URL(address), new AbortController().signal, (message) => calls.push(message));
    expect(calls).toEqual([]);
    await vi.waitFor(() => expect(calls).toEqual(['only http and https addresses can be opened']));
    expect(launches).toEqual([]);
  });

  it('opens an http address', async () => {
    const bin = binDirWith('xdg-open');
    const { launch, launches } = scriptedLaunch(never);
    createBrowserOpener({ env: { PATH: bin }, launch, files: nodeFileSystem })(new URL('http://127.0.0.1:1455/x'), new AbortController().signal, () => undefined);
    await vi.waitFor(() => expect(launches.map(({ args }) => args)).toEqual([['http://127.0.0.1:1455/x']]));
  });

  it('a search failure while the watch lives is reported, not thrown', async () => {
    const { launch, launches } = scriptedLaunch(never);
    const calls: string[] = [];
    const files = {
      stat: async () => {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      },
      access: nodeFileSystem.access,
    };
    createBrowserOpener({ env: { PATH: binDirWith() }, launch, files })(URL_TO_OPEN, new AbortController().signal, (message) => calls.push(message));
    await vi.waitFor(() => expect(calls).toEqual(['EIO: i/o error']));
    expect(launches).toEqual([]);
  });

  it('the watch aborted during the search: nothing is started', async () => {
    const bin = binDirWith('xdg-open');
    const { launch, launches } = scriptedLaunch(never);
    const watch = new AbortController();
    let release: () => void = () => undefined;
    let searching = false;
    const files = {
      stat: async (file: string) => {
        searching = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return nodeFileSystem.stat(file);
      },
      access: nodeFileSystem.access,
    };
    createBrowserOpener({ env: { PATH: bin }, launch, files })(URL_TO_OPEN, watch.signal, () => undefined);
    await vi.waitFor(() => expect(searching).toBe(true));
    watch.abort();
    release();
    await afterMicrotasks();
    await afterMicrotasks();
    expect(launches).toEqual([]);
  });

  it('BROWSER is launched directly and never awaited', async () => {
    const bin = binDirWith('xdg-open');
    const browser = path.join(binDirWith('my-browser'), 'my-browser');
    const { launch, launches } = scriptedLaunch(never);
    const calls: string[] = [];
    const returned = createBrowserOpener({ env: { PATH: bin, BROWSER: browser }, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, (message) => calls.push(message));
    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(launches.map(({ file, args }) => ({ file, args }))).toEqual([{ file: browser, args: [URL_TO_OPEN.toString()] }]));
    expect(calls).toEqual([]);
  });

  it('reports at most once', async () => {
    const bin = binDirWith('xdg-open');
    const { launch, launches } = scriptedLaunch(() => Promise.reject(new Error('spawn EACCES')));
    const onFailure = vi.fn();
    createBrowserOpener({ env: { PATH: bin }, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, onFailure);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    await settledOf(launches[0]!.end);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('never runs cmd or start', async () => {
    const { launch, launches } = scriptedLaunch(never);
    const calls: string[] = [];
    createBrowserOpener({ env: { PATH: binDirWith('cmd', 'start') }, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, (message) => calls.push(message));
    await vi.waitFor(() => expect(calls).toEqual([NO_OPENER_MESSAGE]));
    expect(launches).toEqual([]);
  });
});
