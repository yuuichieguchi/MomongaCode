import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import type { SkillView } from '@momonga/protocol';
import { App, EXIT_ARM_MS } from '../../src/tui/app.tsx';
import type { AppProps, TuiOutcome } from '../../src/tui/app.tsx';
import type { ExternalEdit } from '../../src/tui/external-editor.ts';
import { fakeBackend, runView } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, renderObservable, untilFrame, untilOutput } from '../ink-helpers.ts';
import { frame, runStarted, start, type } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

const READY = 'mode: manual (shift+tab)';
const TASK_RUNNING = 'A task is running. Esc stops it.';
const paste = (text: string): string => `${KEYS.pasteStart}${text}${KEYS.pasteEnd}`;

const inputLines = (shown: string): string[] =>
  shown
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.replace(/^│ /, '').replace(/\s*│$/, ''));

const startWith = (options: FakeBackendOptions, extra: Partial<AppProps>) => {
  const backend = fakeBackend(options);
  const terminal = fakeScreenTerminal();
  const outcomes: TuiOutcome[] = [];
  const app = renderObservable(<App backend={backend} terminal={terminal} initialMode={undefined} now={Date.now} timers={systemTiming} {...extra} onExit={(outcome) => outcomes.push(outcome)} />);
  return { backend, terminal, app, outcomes };
};

describe('the editor while the daemon is starting', () => {
  const starting = () => {
    const gate = Promise.withResolvers<void>();
    const backend = fakeBackend();
    const boot = backend.boot;
    backend.boot = async () => {
      await gate.promise;
      return boot();
    };
    const exited = Promise.withResolvers<TuiOutcome>();
    const app = renderObservable(<App backend={backend} terminal={fakeScreenTerminal()} initialMode={undefined} now={Date.now} timers={systemTiming} onExit={exited.resolve} />);
    return { backend, app, ready: gate.resolve, exited: exited.promise };
  };

  it('edits the draft, keeps it at Enter with the hint, and has it when the session is ready', async () => {
    const { backend, app, ready } = starting();
    await type(app, 'early', '> early');
    app.stdin.write(KEYS.enter);
    const shown = await untilFrame(app, 'Still starting. Your text is kept.');
    expect(shown).toContain('> early');
    expect(backend.started).toEqual([]);
    app.stdin.write('!');
    await untilFrame(app, (now) => now.includes('> early!') && !now.includes('Still starting. Your text is kept.'));
    ready();
    const idle = await untilFrame(app, READY);
    expect(idle).toContain('> early!');
    app.stdin.write(KEYS.enter);
    await backend.called('openSession');
    await untilOutput(app, '> early!');
    expect(backend.started).toEqual([{ text: 'early!', history: 'inherit' }]);
    app.unmount();
  });

  it('takes the newline keys and leaves Tab, Esc and ctrl+d without effect', async () => {
    const { app, backend } = starting();
    await type(app, 'a', '> a');
    app.stdin.write(KEYS.ctrlJ);
    await type(app, 'b', '  b');
    for (const key of [KEYS.tab, KEYS.escape, KEYS.ctrlD]) app.stdin.write(key);
    await type(app, 'c', '  bc');
    expect(inputLines(app.lastFrame() ?? '')).toEqual(['> a', '  bc']);
    expect(backend.calls).toEqual([]);
    app.unmount();
  });

  it('exits at ctrl+c', async () => {
    const { app, exited } = starting();
    await type(app, 'a', '> a');
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual({});
  });
});

describe('the newline keys', () => {
  it.each([
    ['shift+enter', KEYS.shiftEnter],
    ['alt+enter', KEYS.altEnter],
    ['ctrl+j', KEYS.ctrlJ],
    ['\\ then enter', `\\${KEYS.enter}`],
  ])('%s inserts a line and sends nothing', async (_name, key) => {
    const { backend, app } = await start();
    await untilFrame(app, READY);
    await type(app, 'abc', '> abc');
    app.stdin.write(key);
    await type(app, 'def', '  def');
    expect(inputLines(app.lastFrame() ?? '')).toEqual(['> abc', '  def']);
    expect(backend.started).toEqual([]);
    app.stdin.write(KEYS.enter);
    await untilOutput(app, '> abc\n  def');
    expect(backend.started).toEqual([{ text: 'abc\ndef', history: 'inherit' }]);
    app.unmount();
  });

  it.each([
    ['unknown', 'ctrl+j: new line'],
    ['plain', 'ctrl+j: new line'],
    ['modify-other-keys', 'ctrl+j: new line'],
    ['kitty', 'shift+enter: new line'],
    ['proven', 'shift+enter: new line'],
  ] as const)('the hint under the input names the key that works in the state %s', async (negotiation, hint) => {
    const { app, terminal } = await start();
    await untilFrame(app, READY);
    terminal.negotiate(negotiation);
    const shown = await untilFrame(app, hint);
    expect(shown.includes('shift+enter: new line')).toBe(hint.startsWith('shift'));
    app.unmount();
  });
});

describe('the editing keys on the screen', () => {
  it('moves by line end, word and character, deletes to the slot and inserts it again, and undoes', async () => {
    const { app } = await start();
    await untilFrame(app, READY);
    await type(app, 'alpha beta', '> alpha beta');
    app.stdin.write(KEYS.ctrlW);
    await untilFrame(app, (shown) => inputLines(shown)[0] === '> alpha');
    app.stdin.write(KEYS.ctrlA);
    app.stdin.write(KEYS.ctrlY);
    await untilFrame(app, '> betaalpha');
    app.stdin.write(KEYS.altF);
    app.stdin.write(KEYS.altB);
    app.stdin.write(KEYS.right);
    app.stdin.write(KEYS.delete);
    await untilFrame(app, '> btaalpha');
    app.stdin.write(KEYS.ctrlE);
    app.stdin.write(KEYS.backspace);
    await untilFrame(app, '> btaalph');
    app.stdin.write(KEYS.home);
    app.stdin.write(KEYS.ctrlK);
    await untilFrame(app, (shown) => inputLines(shown)[0] === '>');
    app.stdin.write(KEYS.ctrlUnderscore);
    await untilFrame(app, '> btaalph');
    app.stdin.write(KEYS.ctrlUnderscore);
    await untilFrame(app, '> btaalpha');
    app.stdin.write(KEYS.end);
    app.stdin.write(KEYS.ctrlU);
    await untilFrame(app, (shown) => inputLines(shown)[0] === '>');
    app.unmount();
  });

  it('places the caret where the mouse is pressed in the input box', async () => {
    const { app, terminal } = await start();
    await untilFrame(app, READY);
    await type(app, 'hello', '> hello');
    const rows = terminal.state().size.rows;
    expect(terminal.emit({ type: 'mouse', kind: 'press', button: 'left', col: 7, row: rows - 2, ctrl: false, alt: false, shift: false })).toBe(true);
    await type(app, 'X', '> heXllo');
    app.unmount();
  });

  it('does nothing at Tab and at Esc while nothing runs', async () => {
    const { backend, app } = await start();
    await untilFrame(app, READY);
    await type(app, 'draft', '> draft');
    app.stdin.write(KEYS.tab);
    app.stdin.write(KEYS.escape);
    await type(app, '!', '> draft!');
    expect(backend.calls).toEqual(['boot', 'openSession']);
    app.unmount();
  });
});

describe('pastes', () => {
  it('inserts a bracketed paste as text with its line ends normalised', async () => {
    const { app } = await start();
    await untilFrame(app, READY);
    app.stdin.write(paste('one\r\ntwo'));
    await untilFrame(app, '  two');
    expect(inputLines(app.lastFrame() ?? '')).toEqual(['> one', '  two']);
    app.unmount();
  });

  it('shows a long paste as one span, removes it whole at Backspace, and sends and records the full text', async () => {
    const { backend, app } = await start();
    await untilFrame(app, READY);
    const pasted = 'l1\nl2\nl3\nl4\nl5';
    await type(app, 'see ', '> see');
    app.stdin.write(paste(pasted));
    await untilFrame(app, '> see [Pasted text #1 +5 lines]');
    app.stdin.write(KEYS.backspace);
    await untilFrame(app, (shown) => inputLines(shown)[0] === '> see');
    app.stdin.write(paste(pasted));
    await untilFrame(app, '> see [Pasted text #2 +5 lines]');
    app.stdin.write(KEYS.enter);
    await backend.called('openSession');
    await untilOutput(app, '> see l1');
    expect(backend.started).toEqual([{ text: `see ${pasted}`, history: 'inherit' }]);
    expect(backend.recorded).toEqual([`see ${pasted}`]);
    app.unmount();
  });

  it('collapses a paste of more than 800 characters on one line', async () => {
    const { app } = await start();
    await untilFrame(app, READY);
    app.stdin.write(paste('z'.repeat(801)));
    await untilFrame(app, '> [Pasted text #1 +1 lines]');
    app.unmount();
  });
});

describe('typed text while a run works', () => {
  const PDF: SkillView = { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/p/.agents/skills/pdf/SKILL.md' };

  it('sends the draft to the inbox at Enter and at Tab instead of keeping it (5.3), and starts no second run itself', async () => {
    const { backend, app } = await start();
    await untilFrame(app, READY);
    await runStarted(backend, app, 'one');
    await type(app, 'two', '> two');
    app.stdin.write(KEYS.enter);
    await backend.called('inbox:steer:two');
    await type(app, 'three', '> three');
    app.stdin.write(KEYS.tab);
    await backend.called('inbox:queue:three');
    expect(app.lastFrame()).not.toContain(TASK_RUNNING);
    expect(backend.started).toHaveLength(1);
    app.unmount();
  });

  it('still runs a slash command, and answers the hint to one that starts a task', async () => {
    const { backend, app } = await start({ skills: [PDF] });
    await untilFrame(app, READY);
    await runStarted(backend, app, 'one');
    await type(app, '/mode plan', '> /mode plan');
    app.stdin.write(KEYS.enter);
    await backend.called('mode:plan');
    await type(app, '/pdf read it', '> /pdf read it');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, TASK_RUNNING);
    expect(backend.started).toHaveLength(1);
    app.unmount();
  });

  it('stops the run at Esc and at ctrl+c', async () => {
    const { backend, app } = await start();
    await untilFrame(app, READY);
    await runStarted(backend, app, 'one');
    await type(app, 'kept', '> kept');
    app.stdin.write(KEYS.escape);
    await backend.called('cancel:run-1');
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, '> kept');
    expect(backend.calls.filter((call) => call === 'cancel:run-1')).toHaveLength(2);
    app.unmount();
  });
});

describe('history', () => {
  it('walks the history at Up on the first line and returns to the draft at Down', async () => {
    const { app } = await start({ history: ['first', 'second'] });
    await untilFrame(app, READY);
    await type(app, 'draft', '> draft');
    app.stdin.write(KEYS.up);
    await untilFrame(app, '> second');
    app.stdin.write(KEYS.up);
    await untilFrame(app, '> first');
    app.stdin.write(KEYS.down);
    app.stdin.write(KEYS.down);
    await untilFrame(app, '> draft');
    app.unmount();
  });

  it('searches the history at ctrl+r: typing filters, Enter puts the entry in the input', async () => {
    const { backend, app } = await start({ history: ['fix the parser', 'write the tests', 'fix the tests'] });
    await untilFrame(app, READY);
    app.stdin.write(KEYS.ctrlR);
    const list = await untilFrame(app, 'History');
    expect(list.indexOf('fix the tests')).toBeLessThan(list.indexOf('write the tests'));
    expect(list.indexOf('write the tests')).toBeLessThan(list.indexOf('fix the parser'));
    app.stdin.write('pars');
    await untilFrame(app, (shown) => shown.includes('fix the parser') && !shown.includes('write the tests'));
    app.stdin.write(KEYS.enter);
    await untilFrame(app, '> fix the parser');
    expect(backend.started).toEqual([]);
    app.unmount();
  });

  it('closes the history search at Esc and keeps the draft', async () => {
    const { app } = await start({ history: ['older'] });
    await untilFrame(app, READY);
    await type(app, 'draft', '> draft');
    app.stdin.write(KEYS.ctrlR);
    await untilFrame(app, 'History');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => shown.includes('> draft') && !shown.includes('History'));
    app.unmount();
  });
});

describe('leaving', () => {
  it('clears the input at ctrl+c, arms the exit on the empty input and exits at the second press', async () => {
    const { app, exited, outcomes } = await start();
    await untilFrame(app, READY);
    await type(app, 'text', '> text');
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, (shown) => inputLines(shown)[0] === '>');
    expect(outcomes).toEqual([]);
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, 'Press ctrl+c again to exit');
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual({});
  });

  it('lets the armed exit lapse at any other key', async () => {
    const { app, outcomes } = await start();
    await untilFrame(app, READY);
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, 'Press ctrl+c again to exit');
    app.stdin.write(KEYS.ctrlD);
    await untilFrame(app, 'Press ctrl+d again to exit');
    app.stdin.write(KEYS.left);
    await untilFrame(app, 'ctrl+j: new line');
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, 'Press ctrl+c again to exit');
    expect(outcomes).toEqual([]);
    app.unmount();
  });

  it(`lets the armed exit lapse after ${EXIT_ARM_MS} ms and shows the normal hint again`, async () => {
    const clock = manualClock();
    const { app, outcomes } = await start({}, { now: clock.now, timers: clock.timers });
    await untilFrame(app, READY);
    app.stdin.write(KEYS.ctrlD);
    await untilFrame(app, 'Press ctrl+d again to exit');
    clock.advance(EXIT_ARM_MS - 1);
    expect(app.lastFrame()).toContain('Press ctrl+d again to exit');
    clock.advance(1);
    await untilFrame(app, 'ctrl+j: new line');
    app.stdin.write(KEYS.ctrlD);
    await untilFrame(app, 'Press ctrl+d again to exit');
    expect(outcomes).toEqual([]);
    app.unmount();
  });

  it('deletes the character after the caret at ctrl+d when there is text', async () => {
    const { app, outcomes } = await start();
    await untilFrame(app, READY);
    await type(app, 'abc', '> abc');
    app.stdin.write(KEYS.left);
    app.stdin.write(KEYS.ctrlD);
    await untilFrame(app, (shown) => inputLines(shown)[0] === '> ab');
    expect(outcomes).toEqual([]);
    app.unmount();
  });
});

describe('the slash menu keys', () => {
  it('completes at Tab, closes at Esc keeping the text, and runs the highlighted command at Enter', async () => {
    const { app } = await start();
    await untilFrame(app, READY);
    await type(app, '/he', '> /he');
    await untilFrame(app, '/help  list the commands, the keys and the mouse actions');
    app.stdin.write(KEYS.tab);
    await untilFrame(app, (shown) => inputLines(shown)[0] === '> /help');
    app.stdin.write(KEYS.ctrlU);
    await type(app, '/mod', '> /mod');
    await untilFrame(app, '/model');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => shown.includes('> /mod') && !shown.includes('/model'));
    app.stdin.write(KEYS.ctrlU);
    await type(app, '/hel', '> /hel');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'Commands\n');
    app.unmount();
  });

  it('closes the menu at ctrl+c without clearing the text and says when nothing matches', async () => {
    const { app } = await start();
    await untilFrame(app, READY);
    await type(app, '/xyz', '> /xyz');
    await untilFrame(app, 'No commands match "/xyz"');
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, (shown) => shown.includes('> /xyz') && !shown.includes('No commands match'));
    app.unmount();
  });
});

describe('the external editor key', () => {
  const editorOf = (outcome: ExternalEdit) => {
    const drafts: string[] = [];
    return {
      drafts,
      port: {
        edit: async (draft: string) => {
          drafts.push(draft);
          return outcome;
        },
      },
    };
  };

  it('hands the draft with its pastes expanded to the editor and puts what comes back in the input', async () => {
    const { drafts, port } = editorOf({ kind: 'edited', text: 'rewritten' });
    const { app } = startWith({}, { externalEditor: port });
    await untilFrame(app, READY);
    app.stdin.write(paste('a\nb\nc\nd'));
    await untilFrame(app, '[Pasted text #1 +4 lines]');
    app.stdin.write(KEYS.ctrlG);
    await untilFrame(app, '> rewritten');
    expect(drafts).toEqual(['a\nb\nc\nd']);
    app.unmount();
  });

  it('says how to set the editor when none is set', async () => {
    const { port } = editorOf({ kind: 'unset' });
    const { app } = startWith({}, { externalEditor: port });
    await untilFrame(app, READY);
    await type(app, 'draft', '> draft');
    app.stdin.write(KEYS.ctrlG);
    expect(await untilFrame(app, 'Set $EDITOR to use ctrl+g.')).toContain('> draft');
    app.unmount();
  });
});
