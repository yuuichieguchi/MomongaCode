import { describe, expect, it } from 'vitest';
import { HANDOVER_FORMAT, encodeRecord } from '../../src/handover/record.ts';
import type { StreamRecord } from '../../src/handover/record.ts';
import { HANDOVER_FLAG, adoptionOf, handoverTarget, refuseStart, takeHandoverStart } from '../../src/handover/start.ts';
import { restoreRefusedText } from '../../src/handover/texts.ts';
import { HANDOVER_TERMINAL_ENV } from '../../src/tui/terminal/constants.ts';
import { handoverTerminalValue, startWithHandoverTerminal } from '../../src/tui/terminal/handover.ts';
import { LEAVE_EVERY_MODE, leaveSequenceOf } from '../../src/tui/terminal/modes.ts';

const FILE = '/home/u/.momonga/run/handover/session-1.json';
const RECORD: StreamRecord = { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: { 'run-1': 4 }, kind: 'attach', runId: 'run-1', output: 'text', verbose: false };
const TERMINAL = { screen: 'fullscreen', modes: ['alt-screen', 'mouse', 'bracketed-paste', 'kitty-keys'] } as const;
const VALUE = handoverTerminalValue({ screen: TERMINAL.screen, modes: [...TERMINAL.modes] });

const textOf = (record: StreamRecord): string => {
  const encoded = encodeRecord(record, 4242);
  if (encoded.kind !== 'fits') throw new Error('the record did not fit');
  return encoded.text;
};

const reading = (files: Readonly<Record<string, string>>) => (file: string): string => {
  const text = files[file];
  if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
  return text;
};

describe('the start of a process that was handed a session (16.6, red test 27)', () => {
  it('takes the flag and its record out of the arguments and the value out of the environment', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin', [HANDOVER_TERMINAL_ENV]: VALUE };
    const taken = takeHandoverStart(['attach', 'run-1', HANDOVER_FLAG, FILE, '--verbose'], env, reading({ [FILE]: textOf(RECORD) }));
    expect(taken.args).toEqual(['attach', 'run-1', '--verbose']);
    expect(taken.started).toEqual({ file: FILE, session: 'session-1', parsed: { kind: 'record', record: RECORD }, terminal: { screen: 'fullscreen', modes: [...TERMINAL.modes] } });
    expect(HANDOVER_TERMINAL_ENV in env).toBe(false);
  });

  it('does not read the value without the flag, and still removes it so that no child sees it', () => {
    const env: Record<string, string | undefined> = { [HANDOVER_TERMINAL_ENV]: VALUE };
    const taken = takeHandoverStart(['attach', 'run-1'], env, reading({}));
    expect(taken).toEqual({ args: ['attach', 'run-1'], started: undefined });
    expect(HANDOVER_TERMINAL_ENV in env).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['unparseable', '{'],
    ['of an unknown version', JSON.stringify({ v: 99, screen: 'fullscreen', modes: [] })],
  ])('knows no modes when the value is %s', (_name, value) => {
    const env: Record<string, string | undefined> = value === undefined ? {} : { [HANDOVER_TERMINAL_ENV]: value };
    expect(takeHandoverStart([HANDOVER_FLAG, FILE], env, reading({ [FILE]: textOf(RECORD) })).started?.terminal).toBeUndefined();
  });

  it('refuses a record it cannot read, naming the session from the file', () => {
    const taken = takeHandoverStart([HANDOVER_FLAG, FILE], {}, reading({}));
    expect(taken.started).toEqual({ file: FILE, session: 'session-1', parsed: { kind: 'refused', reason: `the record could not be read: ENOENT: no such file or directory, open '${FILE}'` }, terminal: undefined });
  });

  it('gives a surface only a record of its own kind', () => {
    const started = takeHandoverStart([HANDOVER_FLAG, FILE], {}, reading({ [FILE]: textOf(RECORD) })).started;
    expect(adoptionOf(undefined, ['attach'])).toEqual({ kind: 'none' });
    expect(adoptionOf(started, ['attach', 'headless'])).toEqual({ kind: 'record', record: RECORD, file: FILE });
    expect(adoptionOf(started, ['tui'])).toEqual({ kind: 'refused', reason: 'the record is of an attach session', kept: { kind: 'run', runId: 'run-1' }, terminal: undefined });
  });
});

describe('the invocation of the new version (6.3)', () => {
  it('is the installed program with the same arguments, the record and the terminal value', () => {
    const target = handoverTarget({ self: { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' }, execArgv: ['--no-warnings'], args: ['--resume', 'abc'], env: { PATH: '/usr/bin' } }, FILE, { screen: 'scrollback', modes: ['bracketed-paste'] });
    expect(target).toEqual({
      file: '/opt/node',
      args: ['--no-warnings', '/opt/momonga/main.js', '--resume', 'abc', HANDOVER_FLAG, FILE],
      env: { PATH: '/usr/bin', [HANDOVER_TERMINAL_ENV]: '{"v":1,"screen":"scrollback","modes":["bracketed-paste"]}' },
    });
  });

  it('sets no terminal value for a client without a screen, and names the single executable itself', () => {
    const target = handoverTarget({ self: { kind: 'single-binary', execPath: '/usr/local/bin/momonga' }, execArgv: [], args: ['acp'], env: { PATH: '/usr/bin' } }, FILE, undefined);
    expect(target).toEqual({ file: '/usr/local/bin/momonga', args: ['acp', HANDOVER_FLAG, FILE], env: { PATH: '/usr/bin' } });
  });
});

const fakeLayer = () => {
  const log: string[] = [];
  return {
    log,
    layer: {
      adopt: (terminal: { screen: string; modes: readonly string[] }, negotiation: string) => void log.push(`adopt:${terminal.screen}:${terminal.modes.join(',')}:${negotiation}`),
      leaveEveryMode: () => void log.push('leave-every-mode'),
      start: () => void log.push('start'),
    },
  };
};

describe('the terminal of the new process (M2, the lost-value rule)', () => {
  it('adopts the modes of the value and starts nothing', () => {
    const { layer, log } = fakeLayer();
    expect(startWithHandoverTerminal(layer, { screen: 'fullscreen', modes: ['alt-screen', 'kitty-keys'] }, 'kitty')).toBe('adopted');
    expect(log).toEqual(['adopt:fullscreen:alt-screen,kitty-keys:kitty']);
  });

  it('leaves every mode of the table once, before anything else, and then starts as an ordinary client when the value was lost', () => {
    const { layer, log } = fakeLayer();
    expect(startWithHandoverTerminal(layer, undefined, 'kitty')).toBe('lost');
    expect(log).toEqual(['leave-every-mode', 'start']);
  });
});

const refusalIo = () => {
  const log: string[] = [];
  return {
    log,
    io: {
      stderr: { write: (text: string) => void log.push(`stderr:${text}`) },
      terminal: { output: { writeSync: (text: string) => void log.push(`terminal:${text}`) }, input: { setRawMode: (on: boolean) => void log.push(`raw:${String(on)}`) } },
    },
  };
};

describe('a new process that does not adopt (M3, red tests 17 and 25)', () => {
  it('restores exactly the modes of the value, then prints the message, and writes nothing else', () => {
    const { io, log } = refusalIo();
    const code = refuseStart(io, { reason: 'the record is not JSON', kept: { kind: 'unnamed' }, terminal: { screen: 'fullscreen', modes: ['alt-screen', 'kitty-keys'] } });
    expect(code).toBe(1);
    expect(log).toEqual([`terminal:${leaveSequenceOf(['alt-screen', 'kitty-keys'])}`, 'raw:false', `stderr:momonga: ${restoreRefusedText({ reason: 'the record is not JSON', kept: { kind: 'unnamed' } })}\n`]);
  });

  it('leaves every mode of the table when the value was lost', () => {
    const { io, log } = refusalIo();
    refuseStart(io, { reason: 'the record is not JSON', kept: { kind: 'unnamed' }, terminal: undefined });
    expect(log.slice(0, 2)).toEqual([`terminal:${LEAVE_EVERY_MODE}`, 'raw:false']);
  });

  it('writes no sequence for a client without a screen', () => {
    const { io, log } = refusalIo();
    refuseStart({ stderr: io.stderr }, { reason: 'the record is not JSON', kept: { kind: 'unnamed' }, terminal: undefined });
    expect(log).toEqual([`stderr:momonga: ${restoreRefusedText({ reason: 'the record is not JSON', kept: { kind: 'unnamed' } })}\n`]);
  });
});
