import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import type { ProcessEvent } from '../../src/tui/terminal/layer.ts';
import { BACKGROUND_QUERY, QUERY_BATCH, TERMINAL_MODES } from '../../src/tui/terminal/modes.ts';
import { NOTIFICATION_MAX_BYTES, TITLE_MAX_CHARACTERS, TITLE_STATES, notificationSequence, notificationText, titleOf, titleSequence, titleStateOf, tmuxPassthrough } from '../../src/tui/terminal/title.ts';
import { manualClock } from './screen-clock.ts';

const ESC = '\u001b';
const PUSH_TITLE = `${ESC}[22;2t`;
const POP_TITLE = `${ESC}[23;2t`;
const FOCUS_IN = `${ESC}[I`;
const DA1_QUERY = `${ESC}[c`;
const DA1_REPLY = `${ESC}[?1;2c`;

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
  it.each(TITLE_STATES)('begins with the state %s, then the project folder, then the product', (state) => {
    expect(titleOf('/Users/ada/src/momonga-demo', state)).toBe(`${state} · momonga-demo · momonga`);
  });

  it('has exactly the five states of the design', () => {
    expect(TITLE_STATES).toEqual(['ready', 'working', 'waiting for you', 'done', 'error']);
  });

  it('is written with OSC 2', () => {
    expect(titleSequence('ready · x · momonga')).toBe(`${ESC}]2;ready · x · momonga${ESC}\\`);
  });

  it('removes what a terminal would act on from a hostile folder name', () => {
    expect(titleOf(`/srv/a${ESC}]0;pwn\u0007b\u009b2J\u202ec\n\td`, 'working')).toBe('working · a]0;pwnb2Jcd · momonga');
    expect(titleOf(`/srv/x${ESC}\\${ESC}]52;c;AAAA${ESC}\\`, 'done')).not.toContain(ESC);
  });

  it.each(TITLE_STATES)('is cut to its bound in the folder name, so the state %s stays whole', (state) => {
    const title = titleOf(`/srv/${'字'.repeat(300)}`, state);
    expect([...title].length).toBeLessThanOrEqual(TITLE_MAX_CHARACTERS);
    expect(TITLE_MAX_CHARACTERS).toBe(120);
    expect(title.startsWith(`${state} · 字`)).toBe(true);
    expect(title.endsWith('字 · momonga')).toBe(true);
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
    t.feed(DA1_REPLY);
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
    expect(t.writes.join('')).toBe(`${BACKGROUND_QUERY}${DA1_QUERY}`);
    t.feed(`${ESC}]11;rgb:ffff/ffff/ffff\u0007${DA1_REPLY}`);
    expect(t.layer.state().backgroundColor).toBe('rgb:ffff/ffff/ffff');
  });
});

const BEL = '\u0007';
const OSC9 = `${ESC}]9;`;
const bodyOf = (sequence: string): string => {
  expect(sequence.startsWith(OSC9)).toBe(true);
  expect(sequence.endsWith(BEL)).toBe(true);
  return sequence.slice(OSC9.length, -BEL.length);
};
const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('the desktop notification sequence', () => {
  it('is OSC 9 with the text, ended by BEL', () => {
    expect(notificationSequence('done · myproject · momonga')).toBe(`${ESC}]9;done · myproject · momonga${BEL}`);
  });

  it('removes ESC, BEL, C1 controls and new lines from the text', () => {
    expect(notificationSequence(`a${ESC}b${BEL}c\u009cd\ne`)).toBe(`${OSC9}abcde${BEL}`);
  });

  it('holds no control character inside its body', () => {
    const body = bodyOf(notificationSequence(`done${ESC}]0;pwn${BEL}\u009b2J\r\n\t · x · momonga`));
    expect(body).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('caps its text at 255 UTF-8 bytes', () => {
    expect(NOTIFICATION_MAX_BYTES).toBe(255);
  });

  it('keeps a text of exactly 255 bytes whole', () => {
    expect(bodyOf(notificationSequence('a'.repeat(255)))).toBe('a'.repeat(255));
    expect(bodyOf(notificationSequence('あ'.repeat(85)))).toBe('あ'.repeat(85));
  });

  it('cuts a longer text to at most 252 bytes and appends an ellipsis', () => {
    expect(bodyOf(notificationSequence('a'.repeat(256)))).toBe(`${'a'.repeat(252)}…`);
  });

  it('cuts multi-byte text on a character boundary', () => {
    const body = bodyOf(notificationSequence(`a${'あ'.repeat(100)}`));
    expect(body).toBe(`a${'あ'.repeat(83)}…`);
    expect(bytesOf(body)).toBe(253);
  });

  it('counts the bytes after the controls are removed', () => {
    expect(bodyOf(notificationSequence(`${'a'.repeat(255)}${ESC}`))).toBe('a'.repeat(255));
  });
});

describe('the desktop notification text', () => {
  it('joins the description and the folder with a middle dot', () => {
    expect(notificationText('Run complete in 32s', 'myproject')).toBe('Run complete in 32s · myproject');
  });

  it('is the description alone when no folder is given', () => {
    expect(notificationText('Do you trust the files in /tmp/work/myproject?', undefined)).toBe('Do you trust the files in /tmp/work/myproject?');
  });

  it('turns every run of spaces, tabs and new lines into one space', () => {
    expect(notificationText('Permission requested: npm test\n  &&\tnpm run   build', 'myproject')).toBe('Permission requested: npm test && npm run build · myproject');
    expect(notificationText('Run failed: a\n\n\tb', 'my\t\nproject')).toBe('Run failed: a b · my project');
  });

  it('removes ESC, BEL and C1 controls', () => {
    expect(notificationText(`a${ESC}b${BEL}c\u009cd`, `x${ESC}y\u009cz`)).toBe('abcd · xyz');
  });

  it('trims leading and trailing space of both parts', () => {
    expect(notificationText('  Run failed \n', ' \tmyproject\n')).toBe('Run failed · myproject');
  });

  it('keeps a text of exactly 255 bytes whole', () => {
    expect(notificationText('a'.repeat(242), 'myproject')).toBe(`${'a'.repeat(242)} · myproject`);
    expect(notificationText('a'.repeat(255), undefined)).toBe('a'.repeat(255));
  });

  it('cuts a longer description with an ellipsis and keeps the folder whole', () => {
    const text = notificationText('a'.repeat(243), 'myproject');
    expect(text).toBe(`${'a'.repeat(239)}… · myproject`);
    expect(bytesOf(text)).toBe(255);
  });

  it('cuts a longer text without a folder at the end with an ellipsis', () => {
    expect(notificationText('a'.repeat(256), undefined)).toBe(`${'a'.repeat(252)}…`);
  });

  it('cuts a multi-byte description on a character boundary', () => {
    const text = notificationText('あ'.repeat(100), 'myproject');
    expect(text).toBe(`${'あ'.repeat(79)}… · myproject`);
    expect(bytesOf(text)).toBe(253);
  });

  it('keeps a multi-byte folder whole', () => {
    const text = notificationText('a'.repeat(300), 'プロジェクト');
    expect(text).toBe(`${'a'.repeat(230)}… · プロジェクト`);
    expect(bytesOf(text)).toBe(255);
  });

  it('cuts the whole text from the end when the folder alone leaves no room', () => {
    const text = notificationText('x', 'b'.repeat(300));
    expect(text).toBe(`x · ${'b'.repeat(247)}…`);
    expect(bytesOf(text)).toBe(255);
  });

  it('passes through the OSC 9 sequence unchanged', () => {
    const text = notificationText(`Permission requested: ${'a'.repeat(300)}`, 'myproject');
    expect(notificationSequence(text)).toBe(`${OSC9}${text}${BEL}`);
  });
});

describe('the tmux passthrough', () => {
  it('wraps a sequence in a DCS tmux; string with every ESC doubled', () => {
    expect(tmuxPassthrough(`${ESC}]9;hi${BEL}`)).toBe(`${ESC}Ptmux;${ESC}${ESC}]9;hi${BEL}${ESC}\\`);
  });

  it('doubles every ESC of the sequence, not only the first', () => {
    expect(tmuxPassthrough(`${ESC}]2;t${ESC}\\`)).toBe(`${ESC}Ptmux;${ESC}${ESC}]2;t${ESC}${ESC}\\${ESC}\\`);
  });
});
