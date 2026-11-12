import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { cachedProgramSearch, chooseClipboardRoute, clipboardReadMessage, copyMessage, copyThroughRoutes, readClipboardThroughRoutes } from '../../src/tui/screen/clipboard.ts';
import type { ClipboardHost, ClipboardReadHost } from '../../src/tui/screen/clipboard.ts';
import { CLIPBOARD_READ_MS, COPY_MAX_BYTES, OSC52_MAX_RAW_BYTES } from '../../src/tui/screen/constants.ts';

const fakeHost = (given: { env?: Record<string, string>; programs?: readonly string[]; pipeFailure?: Error } = {}) => {
  const piped: { file: string; args: readonly string[]; payload: string }[] = [];
  const written: string[] = [];
  const host: ClipboardHost = {
    env: given.env ?? {},
    findProgram: async (name) => ((given.programs ?? []).includes(name) ? `/fake/bin/${name}` : undefined),
    pipe: async (file, args, payload) => {
      if (given.pipeFailure !== undefined) throw given.pipeFailure;
      piped.push({ file, args, payload });
    },
    writeTerminal: (text) => {
      written.push(text);
    },
  };
  return { host, piped, written };
};

const osc52 = (text: string): string => `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;

describe('the clipboard routes', () => {
  it('uses the first clipboard program the host has, with the arguments of that program', async () => {
    const cases: [readonly string[], Record<string, string>, string, readonly string[]][] = [
      [['pbcopy', 'xclip'], { DISPLAY: ':0' }, 'pbcopy', []],
      [['wl-copy', 'xclip'], { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'wl-copy', []],
      [['wl-copy', 'xclip', 'xsel'], { DISPLAY: ':0' }, 'xclip', ['-selection', 'clipboard']],
      [['xsel'], { DISPLAY: ':0' }, 'xsel', ['--clipboard', '--input']],
      [['clip.exe'], {}, 'clip.exe', []],
    ];
    for (const [programs, env, program, args] of cases) {
      const { host, piped, written } = fakeHost({ programs, env });
      expect(await copyThroughRoutes(host, 'héllo')).toEqual({ kind: 'copied', characters: 5 });
      expect(piped).toEqual([{ file: `/fake/bin/${program}`, args, payload: 'héllo' }]);
      expect(written).toEqual([]);
    }
  });

  it('leaves the host programs alone in an SSH session and writes OSC 52', async () => {
    for (const env of [{ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, { SSH_TTY: '/dev/pts/1' }]) {
      const { host, piped, written } = fakeHost({ programs: ['pbcopy'], env });
      expect((await chooseClipboardRoute(host)).name).toBe('osc52');
      expect(await copyThroughRoutes(host, 'text')).toEqual({ kind: 'copied', characters: 4 });
      expect(piped).toEqual([]);
      expect(written).toEqual([osc52('text')]);
    }
  });

  it('hands the text to tmux when TMUX is set and no host program is usable', async () => {
    const { host, piped } = fakeHost({ programs: ['tmux', 'pbcopy'], env: { TMUX: '/tmp/tmux-1/default,1,0', SSH_TTY: '/dev/pts/1' } });
    await copyThroughRoutes(host, 'text');
    expect(piped).toEqual([{ file: '/fake/bin/tmux', args: ['load-buffer', '-w', '-'], payload: 'text' }]);
    expect((await chooseClipboardRoute(fakeHost({ programs: ['pbcopy'], env: { TMUX: 'x' } }).host)).name).toBe('pbcopy');
    expect((await chooseClipboardRoute(fakeHost({ programs: [], env: { TMUX: 'x' } }).host)).name).toBe('osc52');
  });

  it('refuses a text above the terminal bound on the OSC 52 route and above the copy bound on every route', async () => {
    const terminalOnly = fakeHost();
    expect(await copyThroughRoutes(terminalOnly.host, 'a'.repeat(OSC52_MAX_RAW_BYTES))).toEqual({ kind: 'copied', characters: OSC52_MAX_RAW_BYTES });
    expect(await copyThroughRoutes(terminalOnly.host, 'a'.repeat(OSC52_MAX_RAW_BYTES + 1))).toEqual({ kind: 'too-large', bytes: OSC52_MAX_RAW_BYTES + 1, through: 'terminal' });
    expect(terminalOnly.written).toHaveLength(1);
    const program = fakeHost({ programs: ['pbcopy'] });
    expect(await copyThroughRoutes(program.host, 'a'.repeat(COPY_MAX_BYTES + 1))).toEqual({ kind: 'too-large', bytes: COPY_MAX_BYTES + 1, through: 'any' });
    expect(program.piped).toEqual([]);
    expect(OSC52_MAX_RAW_BYTES).toBe(100000);
    expect(COPY_MAX_BYTES).toBe(1024 * 1024);
  });

  it('reports the cause when the program could not be started or written to, and tries no other route', async () => {
    const { host, written } = fakeHost({ programs: ['pbcopy'], pipeFailure: new Error('spawn pbcopy EACCES') });
    expect(await copyThroughRoutes(host, 'text')).toEqual({ kind: 'failed', cause: 'spawn pbcopy EACCES' });
    expect(written).toEqual([]);
  });

  it('words each outcome for the footer', () => {
    expect(copyMessage({ kind: 'copied', characters: 120 })).toBe('Copied 120 characters');
    expect(copyMessage({ kind: 'failed', cause: 'spawn pbcopy EACCES' })).toBe('Could not copy: spawn pbcopy EACCES');
    expect(copyMessage({ kind: 'too-large', bytes: 100001, through: 'terminal' })).toBe('Too large to copy through the terminal (100001 bytes)');
    expect(copyMessage({ kind: 'too-large', bytes: 2000000, through: 'any' })).toBe('Too large to copy (2000000 bytes)');
  });
});

const readHost = (given: { env?: Record<string, string>; programs?: readonly string[]; outputs?: Record<string, Uint8Array> } = {}) => {
  const captured: { file: string; args: readonly string[] }[] = [];
  let pending: ((value: Uint8Array | undefined) => void) | undefined;
  const host: ClipboardReadHost = {
    env: given.env ?? {},
    findProgram: async (name) => ((given.programs ?? []).includes(name) ? `/fake/bin/${name}` : undefined),
    capture: (file, args, _maxBytes, signal) => {
      captured.push({ file, args });
      const output = given.outputs?.[file.slice('/fake/bin/'.length)];
      if (output !== undefined) return Promise.resolve(output);
      return new Promise((resolve, reject) => {
        pending = resolve;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  return { host, captured, finish: (value: Uint8Array | undefined) => pending?.(value) };
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('reading the clipboard (P-263, cli-tui-22)', () => {
  it('uses no host program in an SSH session, as the copy does', async () => {
    for (const env of [{ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, { SSH_TTY: '/dev/pts/1' }]) {
      const { host, captured } = readHost({ env: { ...env, DISPLAY: ':0' }, programs: ['osascript', 'pbpaste', 'xclip'] });
      expect(await readClipboardThroughRoutes(host, createFakeTimers(createFakeClock(0)), new AbortController().signal)).toEqual({ kind: 'unsupported' });
      expect(captured).toEqual([]);
    }
  });

  it('stops a read program that never ends at the bound and says the read timed out', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const { host } = readHost({ programs: ['osascript', 'pbpaste'] });
    const read = readClipboardThroughRoutes(host, timers, new AbortController().signal);
    await timers.advanceAsync(CLIPBOARD_READ_MS);
    const content = await read;
    expect(content).toEqual({ kind: 'failed', cause: 'timed out' });
    if (content.kind !== 'failed') throw new Error('the read did not fail');
    expect(clipboardReadMessage(content)).toBe('Could not read the clipboard: timed out');
  });

  it('reads an image and then text on Windows through PowerShell (design 2.7 read direction)', async () => {
    const encoded = new TextEncoder().encode(`${Buffer.from(PNG).toString('base64')}\r\n`);
    const image = readHost({ programs: ['powershell.exe'], outputs: { 'powershell.exe': encoded } });
    expect(await readClipboardThroughRoutes(image.host, createFakeTimers(createFakeClock(0)), new AbortController().signal)).toEqual({ kind: 'image', image: { mediaType: 'image/png', data: Buffer.from(PNG).toString('base64') } });
    expect(image.captured[0]?.file).toBe('/fake/bin/powershell.exe');
    expect(image.captured[0]?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-STA']);
  });

  it('finds each program once per run through the asynchronous search', async () => {
    const asked: string[] = [];
    const find = cachedProgramSearch(async (name) => {
      asked.push(name);
      return name === 'pbcopy' ? '/bin/pbcopy' : undefined;
    });
    expect(await find('pbcopy')).toBe('/bin/pbcopy');
    expect(await find('pbcopy')).toBe('/bin/pbcopy');
    expect(await find('xclip')).toBeUndefined();
    expect(await find('xclip')).toBeUndefined();
    expect(asked).toEqual(['pbcopy', 'xclip']);
  });
});
