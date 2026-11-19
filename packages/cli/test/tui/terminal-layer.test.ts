import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HANDOVER_TERMINAL_ENV, KEY_SETTLE_MS, NEGOTIATION_DRAIN_MS, NO_FULLSCREEN_NOTICE, PASTE_ABANDON_BYTES, PASTE_MAX_BYTES, PASTE_TOO_LARGE_NOTICE } from '../../src/tui/terminal/constants.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { handoverTerminalValue, parseHandoverTerminal, startFromHandover } from '../../src/tui/terminal/handover.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import type { DeliverableSignal, ProcessEvent, ProcessSignal, ScreenRequest, TerminalLayerOptions } from '../../src/tui/terminal/layer.ts';
import { BACKGROUND_QUERY, DEVICE_ATTRIBUTES_QUERY, LEAVE_EVERY_MODE, TERMINAL_MODES } from '../../src/tui/terminal/modes.ts';
import { NEWLINE_HINT } from '../../src/tui/terminal/negotiation.ts';
import { manualClock } from './screen-clock.ts';

const ESC = '\u001b';
const START_QUERIES = `${ESC}[?u${ESC}[>7u${ESC}[?1049$p${ESC}[?1006$p${ESC}[?2004$p${ESC}[?2026$p${ESC}]11;?${ESC}\\${ESC}[c`;
const FULLSCREEN_START = `${ESC}[?1049h${ESC}[?2004h${START_QUERIES}`;
const SCROLLBACK_START = `${ESC}[?2004h${START_QUERIES}`;
const KITTY_REPLY = `${ESC}[?7u`;
const DA1_REPLY = `${ESC}[?1;2c`;
const MOUSE_REPLY = `${ESC}[?1006;2$y`;
const ENTER_MOUSE = `${ESC}[?1000;1002;1003;1006h`;
const ENTER_MODIFY_OTHER_KEYS = `${ESC}[>4;2m`;
const LEAVE_ALL = `${ESC}[?1049l${ESC}[?1000;1002;1003;1006l${ESC}[?2004l${ESC}[?1004l${ESC}[<u${ESC}[>4m${ESC}[23;2t`;

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };

type Fakes = ReturnType<typeof fakes>;

const fakes = (given: Partial<Pick<TerminalLayerOptions, 'screen' | 'screenSetByUser' | 'mouse'>> & { undeliverable?: readonly DeliverableSignal[] } = {}) => {
  const stdin = new EventEmitter();
  const rawModes: boolean[] = [];
  const writes: string[] = [];
  const size = { columns: 80, rows: 24 };
  const resizeListeners = new Set<() => void>();
  const processListeners = new Map<ProcessEvent, Set<() => void>>();
  const kills: ProcessSignal[] = [];
  const delivered: TerminalEvent[] = [];
  const requests: ScreenRequest[] = [];
  const log: string[] = [];
  const clock = manualClock();
  const layer = createTerminalLayer({
    timers: clock.timers,
    input: {
      setRawMode: (on) => {
        rawModes.push(on);
        log.push(`raw:${String(on)}`);
      },
      resume: () => undefined,
      pause: () => undefined,
      on: (event, listener) => stdin.on(event, listener),
      off: (event, listener) => stdin.off(event, listener),
    },
    output: {
      writeSync: (text) => {
        writes.push(text);
        log.push(`write:${text}`);
      },
      size: () => ({ ...size }),
      onResize: (listener) => {
        resizeListeners.add(listener);
        return () => resizeListeners.delete(listener);
      },
    },
    process: {
      on: (event, listener) => {
        processListeners.set(event, (processListeners.get(event) ?? new Set()).add(listener));
      },
      off: (event, listener) => {
        processListeners.get(event)?.delete(listener);
      },
      kill: (signal) => {
        kills.push(signal);
        log.push(`kill:${signal}`);
      },
      deliverable: (signal) => !(given.undeliverable ?? []).includes(signal),
    },
    screen: given.screen ?? 'fullscreen',
    screenSetByUser: given.screenSetByUser ?? false,
    mouse: given.mouse ?? true,
    onFailure: (error) => {
      throw error;
    },
    onEvents: (events) => delivered.push(...events),
  });
  layer.subscribeScreen((request) => requests.push(request));
  return {
    layer,
    clock,
    writes,
    rawModes,
    kills,
    delivered,
    requests,
    log,
    size,
    feed: (text: string) => stdin.emit('data', Buffer.from(text, 'utf8')),
    dataListeners: () => stdin.listenerCount('data'),
    resize: (columns: number, rows: number) => {
      size.columns = columns;
      size.rows = rows;
      for (const listener of [...resizeListeners]) listener();
    },
    resizeListeners: () => resizeListeners.size,
    raise: (event: ProcessEvent) => {
      for (const listener of [...(processListeners.get(event) ?? [])]) listener();
    },
    listening: (event: ProcessEvent) => (processListeners.get(event)?.size ?? 0) > 0,
  };
};

const withEveryMode = (): Fakes => {
  const t = fakes();
  t.layer.start();
  t.feed(`${MOUSE_REPLY}${DA1_REPLY}`);
  t.layer.enable('focus');
  t.layer.enable('title');
  t.writes.length = 0;
  t.log.length = 0;
  return t;
};

describe('the mode table', () => {
  it('is one table of data, each mode with its enter and its leave sequence, in the order of the restore', () => {
    expect(TERMINAL_MODES).toEqual([
      { name: 'alt-screen', enter: `${ESC}[?1049h`, leave: `${ESC}[?1049l` },
      { name: 'mouse', enter: `${ESC}[?1000;1002;1003;1006h`, leave: `${ESC}[?1000;1002;1003;1006l` },
      { name: 'bracketed-paste', enter: `${ESC}[?2004h`, leave: `${ESC}[?2004l` },
      { name: 'focus', enter: `${ESC}[?1004h`, leave: `${ESC}[?1004l` },
      { name: 'kitty-keys', enter: `${ESC}[>7u`, leave: `${ESC}[<u` },
      { name: 'modify-other-keys', enter: `${ESC}[>4;2m`, leave: `${ESC}[>4m` },
      { name: 'title', enter: `${ESC}[22;2t`, leave: `${ESC}[23;2t` },
    ]);
    expect(LEAVE_EVERY_MODE).toBe(LEAVE_ALL);
  });
});

describe('start', () => {
  it('turns raw mode on and writes one batch in the order of the design, in fullscreen', () => {
    const t = fakes();
    t.layer.start();
    expect(t.log).toEqual(['raw:true', `write:${FULLSCREEN_START}`]);
    expect(t.layer.state()).toMatchObject({ screen: 'fullscreen', negotiation: 'unknown', enabled: ['alt-screen', 'bracketed-paste', 'kitty-keys'], synchronizedOutput: false, backgroundColor: undefined });
  });

  it('does not enter the alternate screen in scrollback', () => {
    const t = fakes({ screen: 'scrollback' });
    t.layer.start();
    expect(t.writes).toEqual([SCROLLBACK_START]);
    expect(t.layer.state().enabled).toEqual(['bracketed-paste', 'kitty-keys']);
  });

  it('delivers keys before any reply arrives', () => {
    const t = fakes();
    t.layer.start();
    t.feed('a\r');
    expect(t.delivered).toEqual([
      { type: 'key', text: 'a', ...plain },
      { type: 'key', name: 'enter', ...plain },
    ]);
  });
});

describe('negotiation', () => {
  it('names the newline key of every state', () => {
    expect(NEWLINE_HINT).toEqual({ unknown: 'ctrl+j', plain: 'ctrl+j', 'modify-other-keys': 'ctrl+j', kitty: 'shift+enter', proven: 'shift+enter' });
  });

  it('moves to kitty on the kitty reply and sends no modifyOtherKeys when the answers end', () => {
    const t = fakes();
    t.layer.start();
    t.feed(KITTY_REPLY);
    expect(t.layer.state()).toMatchObject({ negotiation: 'kitty' });
    t.feed(DA1_REPLY);
    expect(t.layer.state().negotiation).toBe('kitty');
    expect(t.writes).toEqual([FULLSCREEN_START]);
  });

  it('sends modifyOtherKeys when the answers end without a kitty reply, and keeps ctrl+j until proof', () => {
    const t = fakes();
    t.layer.start();
    t.feed(DA1_REPLY);
    expect(t.writes).toEqual([FULLSCREEN_START, ENTER_MODIFY_OTHER_KEYS]);
    expect(t.layer.state()).toMatchObject({ negotiation: 'modify-other-keys' });
    expect(t.layer.state().enabled).toContain('modify-other-keys');
    t.feed(`${ESC}[27;2;13~`);
    expect(t.layer.state()).toMatchObject({ negotiation: 'proven' });
    expect(t.delivered).toContainEqual({ type: 'key', name: 'enter', ctrl: false, alt: false, shift: true, super: false, hyper: false, meta: false });
  });

  it('stays unknown and working when the terminal never replies, and a received Shift+Enter proves it', () => {
    const t = fakes();
    t.layer.start();
    t.feed('x');
    expect(t.layer.state()).toMatchObject({ negotiation: 'unknown' });
    t.feed(`${ESC}[13;2u`);
    expect(t.layer.state()).toMatchObject({ negotiation: 'proven' });
  });

  it('does not move back when a kitty reply arrives late', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[13;2u${KITTY_REPLY}${DA1_REPLY}`);
    expect(t.layer.state().negotiation).toBe('proven');
    expect(t.writes).toEqual([FULLSCREEN_START]);
  });

  it('accepts replies split across reads and mixed with keys', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`a${ESC}[?`);
    t.feed(`7ub`);
    expect(t.layer.state().negotiation).toBe('kitty');
    expect(t.delivered.filter((event) => event.type === 'key')).toEqual([
      { type: 'key', text: 'a', ...plain },
      { type: 'key', text: 'b', ...plain },
    ]);
  });

  it('records the synchronized output and background colour replies', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[?2026;2$y${ESC}]11;rgb:0000/0000/0000${ESC}\\`);
    expect(t.layer.state()).toMatchObject({ synchronizedOutput: true, backgroundColor: 'rgb:0000/0000/0000' });
  });

  it('tells subscribers when the state changes and not on ordinary keys', () => {
    const t = fakes();
    t.layer.start();
    let changes = 0;
    t.layer.subscribe(() => {
      changes += 1;
    });
    const before = t.layer.state();
    t.feed('abc');
    expect(changes).toBe(0);
    expect(t.layer.state()).toBe(before);
    t.feed(KITTY_REPLY);
    expect(changes).toBe(1);
  });
});

describe('mouse reporting', () => {
  it.each([1, 2])('is turned on only after the 1006 reply says %i', (value) => {
    const t = fakes();
    t.layer.start();
    expect(t.layer.state().enabled).not.toContain('mouse');
    t.feed(`${ESC}[?1006;${value}$y`);
    expect(t.writes).toEqual([FULLSCREEN_START, ENTER_MOUSE]);
    expect(t.layer.state().enabled).toEqual(['alt-screen', 'mouse', 'bracketed-paste', 'kitty-keys']);
  });

  it.each([0, 3, 4])('stays off when the 1006 reply says %i', (value) => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[?1006;${value}$y`);
    expect(t.writes).toEqual([FULLSCREEN_START]);
  });

  it('stays off when the mouse setting is off', () => {
    const t = fakes({ mouse: false });
    t.layer.start();
    t.feed(MOUSE_REPLY);
    expect(t.writes).toEqual([FULLSCREEN_START]);
  });

  it('is never on in scrollback', () => {
    const t = fakes({ screen: 'scrollback' });
    t.layer.start();
    t.feed(MOUSE_REPLY);
    expect(t.writes).toEqual([SCROLLBACK_START]);
  });
});

describe('a terminal that cannot do fullscreen', () => {
  it.each([0, 4])('leaves the alternate screen with a notice when 1049 was answered %i and the answers ended', (value) => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[?1049;${value}$y`);
    expect(t.layer.state().screen).toBe('fullscreen');
    t.feed(`${MOUSE_REPLY}${DA1_REPLY}`);
    expect(t.writes).toEqual([FULLSCREEN_START, ENTER_MOUSE, ENTER_MODIFY_OTHER_KEYS, `${ESC}[?1000;1002;1003;1006l${ESC}[?1049l`]);
    expect(t.layer.state()).toMatchObject({ screen: 'scrollback', enabled: ['bracketed-paste', 'kitty-keys', 'modify-other-keys'] });
    expect(t.requests).toEqual([{ type: 'notice', text: NO_FULLSCREEN_NOTICE }]);
    expect(NO_FULLSCREEN_NOTICE).toBe('This terminal does not support the full screen; using its own history.');
  });

  it('stays in fullscreen when the user set the screen mode', () => {
    const t = fakes({ screenSetByUser: true });
    t.layer.start();
    t.feed(`${ESC}[?1049;0$y${DA1_REPLY}`);
    expect(t.layer.state().screen).toBe('fullscreen');
    expect(t.requests).toEqual([]);
  });

  it('stays in fullscreen with no reply at all and when 1049 is answered as known', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[?1049;1$y${DA1_REPLY}`);
    expect(t.layer.state().screen).toBe('fullscreen');
  });
});

describe('switching the screen mode', () => {
  it('stops mouse reporting, then leaves the alternate screen', () => {
    const t = fakes();
    t.layer.start();
    t.feed(MOUSE_REPLY);
    t.writes.length = 0;
    t.layer.setScreen('scrollback');
    expect(t.writes).toEqual([`${ESC}[?1000;1002;1003;1006l${ESC}[?1049l`]);
    t.layer.setScreen('scrollback');
    expect(t.writes).toHaveLength(1);
  });

  it('enters the alternate screen and the mouse reporting the terminal answered for', () => {
    const t = fakes({ screen: 'scrollback' });
    t.layer.start();
    t.feed(MOUSE_REPLY);
    t.writes.length = 0;
    t.layer.setScreen('fullscreen');
    expect(t.writes).toEqual([`${ESC}[?1049h${ESC}[?1000;1002;1003;1006h`]);
    expect(t.layer.state()).toMatchObject({ screen: 'fullscreen', enabled: ['alt-screen', 'mouse', 'bracketed-paste', 'kitty-keys'] });
  });
});

describe('the one restore path', () => {
  it('writes the inverse of exactly the entered set, once, in the order of the design, and turns raw mode off', () => {
    const t = withEveryMode();
    t.layer.restore();
    expect(t.log).toEqual([`write:${LEAVE_ALL}`, 'raw:false']);
    expect(t.layer.state().enabled).toEqual([]);
    t.layer.restore();
    t.layer.close();
    t.raise('exit');
    expect(t.log).toHaveLength(2);
  });

  it('leaves only the modes that were entered', () => {
    const t = fakes({ screen: 'scrollback' });
    t.layer.start();
    t.feed(`${KITTY_REPLY}${DA1_REPLY}`);
    t.writes.length = 0;
    t.layer.close();
    expect(t.writes).toEqual([`${ESC}[?2004l${ESC}[<u`]);
  });

  it('does not leave a mode twice when it was entered twice', () => {
    const t = fakes({ screen: 'scrollback' });
    t.layer.start();
    t.layer.enable('focus');
    t.layer.enable('focus');
    t.layer.disable('focus');
    expect(t.writes).toEqual([SCROLLBACK_START, `${ESC}[?1004h`, `${ESC}[?1004l`]);
    t.feed(`${KITTY_REPLY}${DA1_REPLY}`);
    t.writes.length = 0;
    t.layer.close();
    expect(t.writes).toEqual([`${ESC}[?2004l${ESC}[<u`]);
  });

  it('runs on close and stops reading and listening', () => {
    const t = withEveryMode();
    t.layer.close();
    expect(t.log).toEqual([`write:${LEAVE_ALL}`, 'raw:false']);
    expect(t.dataListeners()).toBe(0);
    expect(t.resizeListeners()).toBe(0);
    for (const event of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGCONT', 'uncaughtExceptionMonitor'] as const) expect(t.listening(event), event).toBe(false);
  });

  it.each(['exit', 'uncaughtExceptionMonitor'] as const)('runs on %s and changes nothing else of the process', (event) => {
    const t = withEveryMode();
    t.raise(event);
    expect(t.log).toEqual([`write:${LEAVE_ALL}`, 'raw:false']);
    expect(t.kills).toEqual([]);
    t.raise('exit');
    expect(t.log).toHaveLength(2);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('runs on %s, then raises the signal again with the layer no longer listening', (signal) => {
    const t = withEveryMode();
    t.raise(signal);
    expect(t.log).toEqual([`write:${LEAVE_ALL}`, 'raw:false', `kill:${signal}`]);
    expect(t.listening(signal)).toBe(false);
    t.raise('exit');
    expect(t.log).toHaveLength(3);
  });

  it('registers every exit path at start', () => {
    const t = fakes();
    t.layer.start();
    for (const event of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtExceptionMonitor'] as const) expect(t.listening(event), event).toBe(true);
  });
});

describe('no reply to a query is left for another reader of the terminal', () => {
  const unanswered = (): Fakes => {
    const t = fakes();
    t.layer.start();
    t.writes.length = 0;
    t.log.length = 0;
    return t;
  };

  const LATE_REPLIES = `${ESC}[?1049;1$y${ESC}[?2026;2$y${ESC}]11;rgb:0000/0000/0000${ESC}\\${DA1_REPLY}`;

  it('keeps reading at Ctrl+Z until the last reply has come, consumes the replies, then stops the process', () => {
    const t = unanswered();
    t.feed('\u001a');
    expect(t.kills).toEqual([]);
    expect(t.dataListeners()).toBe(1);
    expect(t.log).toEqual([]);
    t.feed(LATE_REPLIES);
    expect(t.log.slice(-2)).toEqual(['raw:false', 'kill:SIGSTOP']);
    expect(t.layer.state().enabled).toEqual([]);
    expect(t.delivered.filter((event) => event.type === 'key')).toEqual([]);
  });

  it('stops the process at the bound when the terminal never answers', () => {
    const t = unanswered();
    t.feed('\u001a');
    t.clock.advance(NEGOTIATION_DRAIN_MS - 1);
    expect(t.kills).toEqual([]);
    t.clock.advance(1);
    expect(t.kills).toEqual(['SIGSTOP']);
  });

  it('hands the terminal to a program only after the last reply, which the layer consumes', async () => {
    const t = unanswered();
    let left = false;
    const leaving = t.layer.leaveForProgram().then((back) => {
      left = true;
      return back;
    });
    await Promise.resolve();
    expect(left).toBe(false);
    expect(t.dataListeners()).toBe(1);
    t.feed(LATE_REPLIES);
    const back = await leaving;
    expect(t.dataListeners()).toBe(0);
    expect(t.delivered.filter((event) => event.type === 'key')).toEqual([]);
    await back();
  });

  it('hands the terminal to a program at the bound when the terminal never answers', async () => {
    const t = unanswered();
    const leaving = t.layer.leaveForProgram();
    t.clock.advance(NEGOTIATION_DRAIN_MS);
    await leaving;
    expect(t.dataListeners()).toBe(0);
  });

  it('closes only after the last reply, which the layer consumes', async () => {
    const t = unanswered();
    let closed = false;
    const closing = t.layer.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(t.dataListeners()).toBe(1);
    t.feed(LATE_REPLIES);
    await closing;
    expect(t.dataListeners()).toBe(0);
    expect(t.delivered.filter((event) => event.type === 'key')).toEqual([]);
  });

  it('closes at the bound when the terminal never answers', async () => {
    const t = unanswered();
    const closing = t.layer.close();
    t.clock.advance(NEGOTIATION_DRAIN_MS);
    await closing;
    expect(t.dataListeners()).toBe(0);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('on %s reads the replies still owed before it leaves and raises the signal again', (signal) => {
    const t = unanswered();
    t.raise(signal);
    expect(t.kills).toEqual([]);
    t.feed(DA1_REPLY);
    expect(t.kills).toEqual([signal]);
    expect(t.dataListeners()).toBe(0);
  });

  it('asks for the device attributes after the background colour at focus in, and waits for that answer too', () => {
    const t = fakes();
    t.layer.start();
    t.feed(DA1_REPLY);
    t.layer.enable('focus');
    t.writes.length = 0;
    t.feed(`${ESC}[I`);
    expect(t.writes).toEqual([`${BACKGROUND_QUERY}${DEVICE_ATTRIBUTES_QUERY}`]);
    t.feed('\u001a');
    expect(t.kills).toEqual([]);
    t.feed(`${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\${DA1_REPLY}`);
    expect(t.kills).toEqual(['SIGSTOP']);
  });

  it('leaves at once when every query has its answer', () => {
    const t = fakes();
    t.layer.start();
    t.feed(DA1_REPLY);
    t.feed('\u001a');
    expect(t.kills).toEqual(['SIGSTOP']);
  });
});

describe('the signals of a platform', () => {
  it('installs only the signals the platform port reports deliverable', () => {
    const t = fakes({ undeliverable: ['SIGTERM', 'SIGSTOP', 'SIGCONT'] });
    t.layer.start();
    expect(t.listening('SIGINT')).toBe(true);
    expect(t.listening('SIGTERM')).toBe(false);
    t.layer.close();
  });

  it('does not stop the process at Ctrl+Z where the platform cannot stop and continue it', () => {
    const t = fakes({ undeliverable: ['SIGSTOP', 'SIGCONT'] });
    t.layer.start();
    t.log.length = 0;
    t.feed('\u001a');
    expect(t.kills).toEqual([]);
    expect(t.log).toEqual([]);
    t.layer.close();
  });
});

describe('suspend', () => {
  it('restores, stops the process, and on continue enters every saved mode again and asks for a full redraw', () => {
    const t = withEveryMode();
    t.feed('\u001a');
    expect(t.delivered.filter((event) => event.type === 'key')).toEqual([]);
    expect(t.log).toEqual([`write:${LEAVE_ALL}`, 'raw:false', 'kill:SIGSTOP']);
    t.log.length = 0;
    t.raise('SIGCONT');
    expect(t.log).toEqual(['raw:true', `write:${ESC}[?1049h${ESC}[?1000;1002;1003;1006h${ESC}[?2004h${ESC}[?1004h${ESC}[>7u${ESC}[>4;2m${ESC}[22;2t`]);
    expect(t.requests).toEqual([{ type: 'redraw' }]);
    expect(t.listening('SIGCONT')).toBe(false);
    t.feed('a');
    expect(t.delivered).toContainEqual({ type: 'key', text: 'a', ...plain });
  });
});

describe('resize and the size limits', () => {
  it('follows the size the terminal reports', () => {
    const t = fakes();
    t.layer.start();
    expect(t.layer.state()).toMatchObject({ size: { columns: 80, rows: 24 }, tooSmall: false });
    let changes = 0;
    t.layer.subscribe(() => {
      changes += 1;
    });
    t.resize(100, 30);
    expect(t.layer.state().size).toEqual({ columns: 100, rows: 30 });
    expect(changes).toBe(1);
  });

  it.each([
    [20, 6, false],
    [19, 6, true],
    [20, 5, true],
    [19, 5, true],
    [200, 5, true],
  ])('at %i columns and %i rows too small is %s', (columns, rows, tooSmall) => {
    const t = fakes();
    t.layer.start();
    t.resize(columns, rows);
    expect(t.layer.state().tooSmall).toBe(tooSmall);
  });

  it('ignores input while too small, except Ctrl+C in either form, and keeps reading replies', () => {
    const t = fakes();
    t.layer.start();
    t.resize(19, 24);
    t.feed(`a\r${ESC}[200~p${ESC}[201~${ESC}[<0;1;1M\u001a\u0003${ESC}[99;5u${KITTY_REPLY}`);
    expect(t.delivered).toEqual([
      { type: 'key', text: 'c', ctrl: true, alt: false, shift: false, super: false, hyper: false, meta: false },
      { type: 'key', text: 'c', ctrl: true, alt: false, shift: false, super: false, hyper: false, meta: false },
    ]);
    expect(t.kills).toEqual([]);
    expect(t.layer.state().negotiation).toBe('kitty');
    t.resize(80, 24);
    t.feed('a');
    expect(t.delivered).toHaveLength(3);
  });
});

describe('a paste larger than 1 MiB', () => {
  it('is not delivered and the user is told', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[200~${'x'.repeat(PASTE_MAX_BYTES + 1)}${ESC}[201~`);
    expect(t.delivered).toEqual([]);
    expect(t.requests).toEqual([{ type: 'notice', text: PASTE_TOO_LARGE_NOTICE }]);
    expect(PASTE_TOO_LARGE_NOTICE).toBe('The paste was larger than 1 MiB and was not inserted.');
  });
});

describe('the handover', () => {
  const VALUE = '{"v":1,"screen":"fullscreen","modes":["alt-screen","mouse","bracketed-paste","kitty-keys"]}';

  it('writes the value of the exec from the modes in force and releases the terminal without writing', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${KITTY_REPLY}${MOUSE_REPLY}`);
    t.writes.length = 0;
    t.log.length = 0;
    expect(handoverTerminalValue(t.layer.handoverTerminal())).toBe(VALUE);
    t.layer.release();
    expect(t.log).toEqual([]);
    expect(t.dataListeners()).toBe(0);
    t.raise('exit');
    t.raise('SIGTERM');
    expect(t.log).toEqual([]);
  });

  it('reads the value it wrote', () => {
    expect(parseHandoverTerminal(VALUE)).toEqual({ screen: 'fullscreen', modes: ['alt-screen', 'mouse', 'bracketed-paste', 'kitty-keys'] });
  });

  it.each([
    ['absent', undefined],
    ['unparseable', '{"v":1,'],
    ['of an unknown version', '{"v":2,"screen":"fullscreen","modes":[]}'],
    ['with an unknown screen', '{"v":1,"screen":"default","modes":[]}'],
    ['with an unknown mode', '{"v":1,"screen":"fullscreen","modes":["sixel"]}'],
    ['with modes that are not a list', '{"v":1,"screen":"fullscreen","modes":"mouse"}'],
    ['not an object', '7'],
  ])('reads a value that is %s as lost', (_name, value) => {
    expect(parseHandoverTerminal(value)).toBeUndefined();
  });

  it('adopts the modes of the value, writes no enter sequence and asks the terminal nothing', () => {
    const t = fakes({ screen: 'scrollback' });
    const env: Record<string, string | undefined> = { [HANDOVER_TERMINAL_ENV]: VALUE, OTHER: 'kept' };
    expect(startFromHandover(t.layer, env, 'kitty')).toBe('adopted');
    expect(env).toEqual({ OTHER: 'kept' });
    expect(t.log).toEqual(['raw:true']);
    expect(t.layer.state()).toMatchObject({ screen: 'fullscreen', negotiation: 'kitty', enabled: ['alt-screen', 'mouse', 'bracketed-paste', 'kitty-keys'] });
    t.feed('a');
    expect(t.delivered).toEqual([{ type: 'key', text: 'a', ...plain }]);
    t.layer.setScreen('scrollback');
    t.layer.setScreen('fullscreen');
    t.log.length = 0;
    t.layer.close();
    expect(t.log).toEqual([`write:${ESC}[?1049l${ESC}[?1000;1002;1003;1006l${ESC}[?2004l${ESC}[<u`, 'raw:false']);
  });

  it('keeps the adopted hint until a received Shift+Enter proves more', () => {
    const t = fakes();
    startFromHandover(t.layer, { [HANDOVER_TERMINAL_ENV]: VALUE }, 'modify-other-keys');
    expect(NEWLINE_HINT[t.layer.state().negotiation]).toBe('ctrl+j');
    t.feed(`${ESC}[27;2;13~`);
    expect(NEWLINE_HINT[t.layer.state().negotiation]).toBe('shift+enter');
  });

  it.each([
    ['absent', undefined],
    ['unparseable', 'x'],
    ['of an unknown version', '{"v":9,"screen":"fullscreen","modes":[]}'],
  ])('leaves every mode of the table once, before any other write, when the value is %s, then starts as an ordinary client', (_name, value) => {
    const t = fakes();
    const env: Record<string, string | undefined> = { [HANDOVER_TERMINAL_ENV]: value };
    expect(startFromHandover(t.layer, env, 'kitty')).toBe('lost');
    expect(HANDOVER_TERMINAL_ENV in env).toBe(false);
    expect(t.writes).toEqual([LEAVE_ALL, FULLSCREEN_START]);
    expect(t.layer.state()).toMatchObject({ negotiation: 'unknown', enabled: ['alt-screen', 'bracketed-paste', 'kitty-keys'] });
  });
});

describe('a lone ESC and the key settle', () => {
  const escape: TerminalEvent = { type: 'key', name: 'escape', ...plain };
  const up: TerminalEvent = { type: 'key', name: 'up', ...plain };

  it('has one written value', () => {
    expect(KEY_SETTLE_MS).toBe(150);
  });

  it('delivers Escape when the settle ends with no byte, without a next key', () => {
    const t = fakes();
    t.layer.start();
    t.feed(ESC);
    expect(t.delivered).toEqual([]);
    t.clock.advance(KEY_SETTLE_MS - 1);
    expect(t.delivered).toEqual([]);
    t.clock.advance(1);
    expect(t.delivered).toEqual([escape]);
    expect(t.clock.pending()).toBe(0);
  });

  it('reads an arrow whose bytes are split after the ESC within the settle, and waits for nothing more', () => {
    const t = fakes();
    t.layer.start();
    t.feed(ESC);
    t.clock.advance(KEY_SETTLE_MS - 1);
    t.feed('[A');
    expect(t.delivered).toEqual([up]);
    expect(t.clock.pending()).toBe(0);
    t.clock.advance(KEY_SETTLE_MS);
    expect(t.delivered).toEqual([up]);
  });

  it('starts the settle again at each lone ESC', () => {
    const t = fakes();
    t.layer.start();
    t.feed(ESC);
    t.clock.advance(KEY_SETTLE_MS - 1);
    t.feed(ESC);
    expect(t.delivered).toEqual([escape]);
    t.clock.advance(KEY_SETTLE_MS - 1);
    expect(t.delivered).toEqual([escape]);
    t.clock.advance(1);
    expect(t.delivered).toEqual([escape, escape]);
  });

  it('delivers a key release of the kitty protocol as a release event', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[97;1:3u`);
    expect(t.delivered).toEqual([{ type: 'release' }]);
  });

  it('delivers the Alt key of a legacy terminal when ESC [ is followed by no byte for the settle', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[`);
    expect(t.delivered).toEqual([]);
    t.clock.advance(KEY_SETTLE_MS);
    expect(t.delivered).toEqual([{ type: 'key', text: '[', ...plain, alt: true }]);
    t.feed('a');
    expect(t.delivered.at(-1)).toEqual({ type: 'key', text: 'a', ...plain });
  });

  it('reads keys again when an abandoned paste is followed by no byte for the settle', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}[200~${'x'.repeat(PASTE_ABANDON_BYTES)}`);
    expect(t.requests).toEqual([{ type: 'notice', text: PASTE_TOO_LARGE_NOTICE }]);
    t.feed('more of the paste\r');
    t.clock.advance(KEY_SETTLE_MS - 1);
    t.feed('and more\r');
    t.clock.advance(KEY_SETTLE_MS - 1);
    expect(t.delivered).toEqual([]);
    t.clock.advance(1);
    t.feed('a');
    expect(t.delivered).toEqual([{ type: 'key', text: 'a', ...plain }]);
    expect(t.requests).toHaveLength(1);
  });

  it('does not wait for a settle after the terminal was released', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${KITTY_REPLY}${DA1_REPLY}`);
    t.delivered.length = 0;
    t.feed(ESC);
    t.layer.close();
    expect(t.clock.pending()).toBe(0);
    expect(t.delivered).toEqual([]);
  });
});
