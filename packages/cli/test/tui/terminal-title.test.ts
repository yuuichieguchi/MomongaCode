import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import type { ProcessEvent } from '../../src/tui/terminal/layer.ts';
import { BACKGROUND_QUERY, QUERY_BATCH, TERMINAL_MODES } from '../../src/tui/terminal/modes.ts';
import { TITLE_MAX_CHARACTERS, TITLE_STATES, titleOf, titleSequence, titleStateOf } from '../../src/tui/terminal/title.ts';
import { manualClock } from './screen-clock.ts';

const ESC = '\u001b';
const PUSH_TITLE = `${ESC}[22;2t`;
const POP_TITLE = `${ESC}[23;2t`;
const FOCUS_IN = `${ESC}[I`;

const fakes = () => {
  const stdin = new EventEmitter();
  const writes: string[] = [];
  const processListeners = new Map<ProcessEvent, Set<() => void>>();
  const layer = createTerminalLayer({
    input: {
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (event, listener) => stdin.on(event, listener),
      off: (event, listener) => stdin.off(event, listener),
    },
    output: {
      writeSync: (text) => {
        writes.push(text);
      },
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
      kill: () => undefined,
      deliverable: () => true,
    },
    timers: manualClock().timers,
    screen: 'scrollback',
    screenSetByUser: false,
    mouse: false,
    onFailure: (error) => {
      throw error;
    },
    onEvents: () => undefined,
  });
  return {
    layer,
    writes,
    feed: (text: string) => stdin.emit('data', Buffer.from(text, 'utf8')),
    raise: (event: ProcessEvent) => {
      for (const listener of [...(processListeners.get(event) ?? [])]) listener();
    },
  };
};

describe('the text of the terminal title', () => {
  it.each(TITLE_STATES)('names the product, the project folder and the state %s', (state) => {
    expect(titleOf('/Users/ada/src/momonga-demo', state)).toBe(`momonga · momonga-demo · ${state}`);
  });

  it('has exactly the five states of the design', () => {
    expect(TITLE_STATES).toEqual(['ready', 'working', 'waiting for you', 'done', 'error']);
  });

  it('is written with OSC 2', () => {
    expect(titleSequence('momonga · x · ready')).toBe(`${ESC}]2;momonga · x · ready${ESC}\\`);
  });

  it('removes what a terminal would act on from a hostile folder name', () => {
    expect(titleOf(`/srv/a${ESC}]0;pwn\u0007b\u009b2J\u202ec\n\td`, 'working')).toBe('momonga · a]0;pwnb2Jcd · working');
    expect(titleOf(`/srv/x${ESC}\\${ESC}]52;c;AAAA${ESC}\\`, 'done')).not.toContain(ESC);
  });

  it.each(TITLE_STATES)('is cut to its bound in the folder name, so the state %s stays whole', (state) => {
    const title = titleOf(`/srv/${'字'.repeat(300)}`, state);
    expect([...title]).toHaveLength(TITLE_MAX_CHARACTERS);
    expect(TITLE_MAX_CHARACTERS).toBe(120);
    expect(title.startsWith('momonga · 字')).toBe(true);
    expect(title.endsWith(`字 · ${state}`)).toBe(true);
  });
});

describe('the state the title names', () => {
  const idle = { working: false, prompting: false, lastRun: undefined } as const;

  it('is ready when nothing runs and no run has ended', () => {
    expect(titleStateOf(idle)).toBe('ready');
  });

  it('is working while a run works', () => {
    expect(titleStateOf({ ...idle, working: true })).toBe('working');
    expect(titleStateOf({ ...idle, working: true, lastRun: 'error' })).toBe('working');
  });

  it('is waiting for you while an approval, a question or trust is open, also during a run', () => {
    expect(titleStateOf({ ...idle, prompting: true })).toBe('waiting for you');
    expect(titleStateOf({ working: true, prompting: true, lastRun: 'done' })).toBe('waiting for you');
  });

  it('is done or error after the last run, by how it ended', () => {
    expect(titleStateOf({ ...idle, lastRun: 'done' })).toBe('done');
    expect(titleStateOf({ ...idle, lastRun: 'error' })).toBe('error');
  });
});

describe('the title in the terminal layer', () => {
  it('saves the title of the terminal before it writes its own and gives it back on restore', () => {
    const t = fakes();
    t.layer.start();
    t.writes.length = 0;
    t.layer.setTitle('momonga · demo');
    expect(t.writes.join('')).toBe(`${PUSH_TITLE}${titleSequence('momonga · demo')}`);
    expect(t.layer.state().enabled).toContain('title');
    t.writes.length = 0;
    t.layer.restore();
    expect(t.writes.join('')).toContain(POP_TITLE);
    expect(t.layer.state().enabled).not.toContain('title');
  });

  it('pushes and pops the title stack with the bytes of the design', () => {
    expect(PUSH_TITLE).toBe(`${ESC}[22;2t`);
    expect(TERMINAL_MODES.find((mode) => mode.name === 'title')).toEqual({ name: 'title', enter: PUSH_TITLE, leave: POP_TITLE });
  });

  it('rings the bell with one BEL', () => {
    const t = fakes();
    t.layer.start();
    t.writes.length = 0;
    t.layer.bell();
    expect(t.writes).toEqual(['\u0007']);
  });

  it('does not save the title twice', () => {
    const t = fakes();
    t.layer.start();
    t.layer.setTitle('momonga · one');
    t.writes.length = 0;
    t.layer.setTitle('momonga · two');
    expect(t.writes.join('')).toBe(titleSequence('momonga · two'));
  });

  it('writes its title again when the process continues after a stop', () => {
    const t = fakes();
    t.layer.start();
    t.layer.setTitle('momonga · demo');
    t.layer.suspend();
    t.writes.length = 0;
    t.raise('SIGCONT');
    const written = t.writes.join('');
    expect(written).toContain(PUSH_TITLE);
    expect(written.indexOf(titleSequence('momonga · demo'))).toBeGreaterThan(written.indexOf(PUSH_TITLE));
  });
});

describe('the background colour query', () => {
  it('is part of the start batch', () => {
    expect(BACKGROUND_QUERY).toBe(`${ESC}]11;?${ESC}\\`);
    expect(QUERY_BATCH).toContain(BACKGROUND_QUERY);
  });

  it('is repeated on focus in while focus reporting is enabled, and the new answer replaces the old one', () => {
    const t = fakes();
    t.layer.start();
    t.feed(`${ESC}]11;rgb:0000/0000/0000\u0007`);
    expect(t.layer.state().backgroundColor).toBe('rgb:0000/0000/0000');
    t.writes.length = 0;
    t.feed(FOCUS_IN);
    expect(t.writes.join('')).toBe('');
    t.layer.enable('focus');
    t.writes.length = 0;
    t.feed(FOCUS_IN);
    expect(t.writes.join('')).toBe(BACKGROUND_QUERY);
    t.feed(`${ESC}]11;rgb:ffff/ffff/ffff\u0007`);
    expect(t.layer.state().backgroundColor).toBe('rgb:ffff/ffff/ffff');
  });
});
