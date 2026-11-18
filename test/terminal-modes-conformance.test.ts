import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalEvent } from '../packages/cli/src/tui/terminal/events.ts';
import { createTerminalLayer } from '../packages/cli/src/tui/terminal/layer.ts';
import type { ProcessEvent, ProcessSignal } from '../packages/cli/src/tui/terminal/layer.ts';
import { BACKGROUND_QUERY, DECRQM_ALT_SCREEN, DECRQM_BRACKETED_PASTE, DECRQM_SGR_MOUSE, DECRQM_SYNCHRONIZED_OUTPUT, QUERY_BATCH, TERMINAL_MODES, enterSequenceOf } from '../packages/cli/src/tui/terminal/modes.ts';
import type { ScreenMode, TerminalModeName } from '../packages/cli/src/tui/terminal/modes.ts';
import { NEGOTIATION_STATES, NEWLINE_HINT } from '../packages/cli/src/tui/terminal/negotiation.ts';

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'TerminalModes.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const ESC = '\u001b';

const definitionOf = (name: string): string => {
  const match = spec.match(new RegExp(`^${name}(\\([^)]*\\))? ==(.*)$`, 'm'));
  if (match === null) throw new Error(`${name} is not defined in ${specPath}`);
  return (match[2] as string).trim();
};

const stringsOf = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((found) => found[1] as string);

const QUERY_TEXT: Readonly<Record<string, string>> = {
  kitty: `${ESC}[?u${enterSequenceOf(['kitty-keys'])}`,
  [String(DECRQM_ALT_SCREEN)]: `${ESC}[?${DECRQM_ALT_SCREEN}$p`,
  [String(DECRQM_SGR_MOUSE)]: `${ESC}[?${DECRQM_SGR_MOUSE}$p`,
  [String(DECRQM_BRACKETED_PASTE)]: `${ESC}[?${DECRQM_BRACKETED_PASTE}$p`,
  [String(DECRQM_SYNCHRONIZED_OUTPUT)]: `${ESC}[?${DECRQM_SYNCHRONIZED_OUTPUT}$p`,
  osc11: BACKGROUND_QUERY,
  da1: `${ESC}[c`,
};

const REPLY_TEXT: Readonly<Record<string, string>> = {
  kitty: `${ESC}[?7u`,
  [String(DECRQM_ALT_SCREEN)]: `${ESC}[?${DECRQM_ALT_SCREEN};1$y`,
  [String(DECRQM_SGR_MOUSE)]: `${ESC}[?${DECRQM_SGR_MOUSE};2$y`,
  [String(DECRQM_BRACKETED_PASTE)]: `${ESC}[?${DECRQM_BRACKETED_PASTE};2$y`,
  [String(DECRQM_SYNCHRONIZED_OUTPUT)]: `${ESC}[?${DECRQM_SYNCHRONIZED_OUTPUT};2$y`,
  osc11: `${ESC}]11;rgb:0000/0000/0000${ESC}\\`,
  da1: `${ESC}[?1;2c`,
};

const ALT_REFUSED_REPLY = `${ESC}[?${DECRQM_ALT_SCREEN};0$y`;

const terminalOf = (screen: ScreenMode) => {
  const stdin = new EventEmitter();
  const term = new Set<TerminalModeName>();
  const raw: boolean[] = [];
  const badLeaves: string[] = [];
  const delivered: TerminalEvent[] = [];
  const processListeners = new Map<ProcessEvent, Set<() => void>>();
  const kills: ProcessSignal[] = [];
  const apply = (text: string): void => {
    let rest = text;
    while (rest.length > 0) {
      const mode = TERMINAL_MODES.find((candidate) => rest.startsWith(candidate.enter) || rest.startsWith(candidate.leave));
      if (mode === undefined) {
        rest = rest.slice(1);
        continue;
      }
      if (rest.startsWith(mode.enter)) {
        term.add(mode.name);
        rest = rest.slice(mode.enter.length);
      } else {
        if (!term.has(mode.name)) badLeaves.push(mode.name);
        term.delete(mode.name);
        rest = rest.slice(mode.leave.length);
      }
    }
  };
  const layer = createTerminalLayer({
    timers: { setTimeout: () => ({}), clearTimeout: () => undefined },
    input: {
      setRawMode: (on) => {
        raw.push(on);
      },
      resume: () => undefined,
      pause: () => undefined,
      on: (event, listener) => stdin.on(event, listener),
      off: (event, listener) => stdin.off(event, listener),
    },
    output: {
      writeSync: (text) => apply(text),
      size: () => ({ columns: 80, rows: 24 }),
      onResize: () => () => undefined,
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
      },
      deliverable: () => true,
    },
    screen,
    screenSetByUser: false,
    mouse: true,
    onFailure: (error) => {
      throw error;
    },
    onEvents: (events) => delivered.push(...events),
  });
  return {
    layer,
    term: () => [...term].sort(),
    enabled: () => [...layer.state().enabled].sort(),
    rawNow: () => raw.at(-1) === true,
    badLeaves,
    delivered,
    kills,
    reply: (query: string) => stdin.emit('data', Buffer.from(REPLY_TEXT[query] as string, 'utf8')),
    feed: (text: string) => stdin.emit('data', Buffer.from(text, 'utf8')),
    raise: (event: ProcessEvent) => {
      for (const listener of [...(processListeners.get(event) ?? [])]) listener();
    },
  };
};

type Terminal = ReturnType<typeof terminalOf>;

const expectRestored = (t: Terminal): void => {
  expect(t.term()).toEqual([]);
  expect(t.rawNow()).toBe(false);
  expect(t.badLeaves).toEqual([]);
};

const everyReply = (t: Terminal, queries: readonly string[]): void => {
  for (const query of queries) {
    t.reply(query);
    expect(t.enabled()).toEqual(t.term());
  }
};

const QUERIES = stringsOf(definitionOf('QueryBatch'));

describe('TerminalModes.tla names what packages/cli/src/tui/terminal names', () => {
  it('Modes are the names of TERMINAL_MODES', () => {
    expect(stringsOf(definitionOf('Modes')).sort()).toEqual(TERMINAL_MODES.map((mode) => mode.name).sort());
  });

  it('NegStates are NEGOTIATION_STATES in their order, the order Monotone and Forward read', () => {
    expect(stringsOf(definitionOf('NegStates'))).toEqual([...NEGOTIATION_STATES]);
  });

  it('Hint of the correct variant is NEWLINE_HINT for every state', () => {
    const shiftStates = stringsOf(definitionOf('Hint').split('\\/')[0] as string);
    for (const state of NEGOTIATION_STATES) expect(NEWLINE_HINT[state], state).toBe(shiftStates.includes(state) ? 'shift+enter' : 'ctrl+j');
  });

  it('every leave path drains: Suspend, Lend and the exit paths wait for LeaveReady, the drain discards replies until the last is read or the bound ends, and the focus-in query is followed by a da1 query so its drain has an end', () => {
    for (const name of ['Drain', 'ReplyDrained', 'DrainBound', 'LeaveReady']) expect(spec, name).toMatch(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
    for (const name of ['Suspend', 'Lend']) expect(spec).toContain(`${name} ==\n    /\\ LeaveReady("${name.toLowerCase()}")`);
    expect(definitionOf('Finish')).toBe('ExitWithRestore(LeaveReady("exit"), FALSE)');
    expect(spec).toContain(`pending' = pending \\o Answered(<<"osc11", "da1">>)`);
  });

  it('QueryBatch is the start batch of the code in its order, the da1 query last', () => {
    expect(QUERIES.map((query) => QUERY_TEXT[query]).join('')).toBe(QUERY_BATCH);
    expect(QUERIES.at(-1)).toBe('da1');
  });
});

describe('the terminal layer follows the actions of TerminalModes.tla (term decoded from the bytes written, enabled from the layer)', () => {
  it('Start, every ReplyToApp, SetTitle, EnableFocus, FocusIn, Switch both ways, then Finish: EnabledIsTerm after every step, MouseGuarded, RestoredOnExit, RestoreIdempotent', () => {
    const t = terminalOf('fullscreen');
    t.layer.start();
    expect(t.term()).toEqual(['alt-screen', 'bracketed-paste', 'kitty-keys']);
    expect(t.term()).not.toContain('mouse');
    everyReply(t, QUERIES);
    expect(t.term()).toContain('mouse');
    t.layer.setTitle('t');
    t.layer.enable('focus');
    t.feed(`${ESC}[I`);
    t.reply('osc11');
    expect(t.enabled()).toEqual(t.term());
    t.layer.setScreen('scrollback');
    expect(t.term()).not.toContain('mouse');
    expect(t.term()).not.toContain('alt-screen');
    t.layer.setScreen('fullscreen');
    expect(t.enabled()).toEqual(t.term());
    t.layer.close();
    expectRestored(t);
    t.layer.restore();
    expectRestored(t);
  });

  it('without a kitty reply the da1 reply sends modify-other-keys, and the scrollback start never enters the alternate screen or the mouse', () => {
    const t = terminalOf('scrollback');
    t.layer.start();
    everyReply(t, QUERIES.filter((query) => query !== 'kitty'));
    expect(t.term()).toEqual(['bracketed-paste', 'kitty-keys', 'modify-other-keys']);
    expect(t.layer.state().negotiation).toBe('modify-other-keys');
    t.raise('SIGTERM');
    expect(t.kills).toEqual(['SIGTERM']);
    expectRestored(t);
  });

  it('the refused alternate screen (1049 answered 0, then da1) switches to scrollback by the one leave path', () => {
    const t = terminalOf('fullscreen');
    t.layer.start();
    t.feed(ALT_REFUSED_REPLY);
    t.reply('1006');
    t.reply('da1');
    expect(t.layer.state().screen).toBe('scrollback');
    expect(t.term()).not.toContain('alt-screen');
    expect(t.term()).not.toContain('mouse');
    expect(t.enabled()).toEqual(t.term());
    t.raise('exit');
    expectRestored(t);
  });

  it('Suspend leaves every enabled mode and raw mode, Continue enters the same set again; a Signal while suspended restores', () => {
    const t = terminalOf('fullscreen');
    t.layer.start();
    everyReply(t, QUERIES);
    const before = t.term();
    t.feed('\u001a');
    expect(t.kills).toEqual(['SIGSTOP']);
    expectRestored(t);
    t.raise('SIGCONT');
    expect(t.term()).toEqual(before);
    expect(t.rawNow()).toBe(true);
    t.feed('\u001a');
    t.raise('SIGTERM');
    expectRestored(t);
  });

  it('Lend leaves every mode for the program and TakeBack enters them again; Uncaught restores', async () => {
    const t = terminalOf('fullscreen');
    t.layer.start();
    everyReply(t, QUERIES);
    const before = t.term();
    const takeBack = t.layer.leaveForProgram();
    expectRestored(t);
    await takeBack();
    expect(t.term()).toEqual(before);
    t.raise('uncaughtExceptionMonitor');
    expectRestored(t);
  });

  it('Release keeps the modes and raw mode for the successor (HandoverKeeps) and Adopt takes them back', () => {
    const t = terminalOf('fullscreen');
    t.layer.start();
    everyReply(t, QUERIES);
    const before = t.term();
    const kept = t.layer.handoverTerminal();
    t.layer.release();
    expect(t.term()).toEqual(before);
    expect(t.rawNow()).toBe(true);
    expect([...kept.modes].sort()).toEqual(before);
    t.layer.adopt(kept, t.layer.state().negotiation);
    expect(t.enabled()).toEqual(t.term());
    t.layer.close();
    expectRestored(t);
  });

  it('ReplyNeverKey: no reply of the start batch or of a focus-in query reaches the app as a key, wherever it falls between keys', () => {
    const t = terminalOf('fullscreen');
    t.layer.start();
    t.layer.enable('focus');
    for (const query of QUERIES) t.feed(`a${REPLY_TEXT[query] as string}b`);
    t.feed(`${ESC}[I`);
    t.feed(`c${REPLY_TEXT['osc11'] as string}d`);
    const keys = t.delivered.filter((event) => event.type === 'key');
    expect(keys.map((event) => ('text' in event ? event.text : 'name' in event ? event.name : ''))).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'c', 'd']);
  });
});
