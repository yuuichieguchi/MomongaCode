import { describe, expect, it } from 'vitest';
import { chooseClipboardRoute, copyMessage, copyThroughRoutes } from '../../src/tui/screen/clipboard.ts';
import type { ClipboardHost } from '../../src/tui/screen/clipboard.ts';
import { COPY_MAX_BYTES, OSC52_MAX_RAW_BYTES } from '../../src/tui/screen/constants.ts';

const fakeHost = (given: { env?: Record<string, string>; programs?: readonly string[]; pipeFailure?: Error } = {}) => {
  const piped: { file: string; args: readonly string[]; payload: string }[] = [];
  const written: string[] = [];
  const host: ClipboardHost = {
    env: given.env ?? {},
    findProgram: (name) => ((given.programs ?? []).includes(name) ? `/fake/bin/${name}` : undefined),
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
      expect(chooseClipboardRoute(host).name).toBe('osc52');
      expect(await copyThroughRoutes(host, 'text')).toEqual({ kind: 'copied', characters: 4 });
      expect(piped).toEqual([]);
      expect(written).toEqual([osc52('text')]);
    }
  });

  it('hands the text to tmux when TMUX is set and no host program is usable', async () => {
    const { host, piped } = fakeHost({ programs: ['tmux', 'pbcopy'], env: { TMUX: '/tmp/tmux-1/default,1,0', SSH_TTY: '/dev/pts/1' } });
    await copyThroughRoutes(host, 'text');
    expect(piped).toEqual([{ file: '/fake/bin/tmux', args: ['load-buffer', '-w', '-'], payload: 'text' }]);
    expect(chooseClipboardRoute(fakeHost({ programs: ['pbcopy'], env: { TMUX: 'x' } }).host).name).toBe('pbcopy');
    expect(chooseClipboardRoute(fakeHost({ programs: [], env: { TMUX: 'x' } }).host).name).toBe('osc52');
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
