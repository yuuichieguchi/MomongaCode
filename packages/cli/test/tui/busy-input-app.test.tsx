import { describe, expect, it } from 'vitest';
import { INBOX_MAX_PENDING } from '@momonga/protocol';
import { runView } from '../fake-backend.ts';
import type { FakeBackend } from '../fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { frame, runStarted, start, type } from '../tui-harness.tsx';

const READY = 'mode: manual (shift+tab)';
const WIDE = { columns: 140, rows: 40 };
const BUSY_HINT = 'enter: queue for after this run · tab: steer after the next tool call · esc: stop';
const TAKE_BACK_HINT = `${BUSY_HINT} · up: take back waiting messages`;
const COMPLETION_HINT = 'tab: complete · esc: close the list';
const TASK_RUNNING = 'A task is running. Esc stops it.';

const inputLines = (shown: string): string[] =>
  shown
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.replace(/^│ /, '').replace(/\s*│$/, ''));

const working = async () => {
  const started = await start({}, {}, WIDE);
  await untilFrame(started.app, READY);
  await runStarted(started.backend, started.app, 'one');
  await untilFrame(started.app, BUSY_HINT);
  return started;
};

const send = async (backend: FakeBackend, app: Instance, key: string, text: string, row: string): Promise<string> => {
  await type(app, text, `> ${text}`);
  app.stdin.write(key);
  return untilFrame(app, (shown) => shown.includes(row) && inputLines(shown).join('') === '>');
};

describe('typing while a run works (design 5.3)', () => {
  it('shows the hint line from the key table only while the run works', async () => {
    const { backend, app } = await start({}, {}, WIDE);
    const idle = await untilFrame(app, READY);
    expect(idle).not.toContain(BUSY_HINT);
    await runStarted(backend, app, 'one');
    const shown = await untilFrame(app, BUSY_HINT);
    expect(shown).not.toContain('take back waiting messages');
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView());
    await untilFrame(app, (now) => !now.includes(BUSY_HINT) && now.includes(READY));
    app.unmount();
  });

  it('queues the draft at Enter, clears the input, and shows the waiting row and the take-back hint', async () => {
    const { backend, app } = await working();
    const shown = await send(backend, app, KEYS.enter, 'two', 'queued  two');
    expect(backend.calls).toContain('inbox:queue:two');
    expect(backend.started).toHaveLength(1);
    expect(backend.recorded).toEqual(['one', 'two']);
    expect(shown).toContain(TAKE_BACK_HINT);
    expect(shown).not.toContain(TASK_RUNNING);
    app.unmount();
  });

  it('steers the run with the draft at Tab, and shows the rows in the order typed', async () => {
    const { backend, app } = await working();
    await send(backend, app, KEYS.tab, 'also the docs', 'steer   also the docs');
    const shown = await send(backend, app, KEYS.enter, 'then release', 'queued  then release');
    expect(backend.calls.filter((call) => call.startsWith('inbox:'))).toEqual(['inbox:steer:also the docs', 'inbox:queue:then release']);
    expect(shown.indexOf('steer   also the docs')).toBeLessThan(shown.indexOf('queued  then release'));
    expect(shown.indexOf('queued  then release')).toBeLessThan(shown.indexOf('╭'));
    app.unmount();
  });

  it('does nothing at Enter and at Tab on an empty draft', async () => {
    const { backend, app } = await working();
    app.stdin.write(KEYS.enter);
    app.stdin.write(KEYS.tab);
    await type(app, 'x', '> x');
    expect(backend.calls.filter((call) => call.startsWith('inbox:'))).toEqual([]);
    expect(inputLines(app.lastFrame() ?? '')).toEqual(['> x']);
    app.unmount();
  });

  it('completes at Tab while the slash menu is open and does not steer, and names the keys of the list in the hint', async () => {
    const { backend, app } = await working();
    await type(app, '/mod', '> /mod');
    const open = await untilFrame(app, COMPLETION_HINT);
    expect(open).not.toContain(BUSY_HINT);
    app.stdin.write(KEYS.tab);
    await untilFrame(app, (shown) => inputLines(shown)[0]?.startsWith('> /mode') === true);
    expect(backend.calls.filter((call) => call.startsWith('inbox:'))).toEqual([]);
    app.unmount();
  });

  it('closes the list at Esc without stopping the run, and never steers a draft that is a slash command', async () => {
    const { backend, app } = await working();
    await type(app, '/mod', '> /mod');
    await untilFrame(app, COMPLETION_HINT);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, BUSY_HINT);
    app.stdin.write(KEYS.tab);
    await type(app, 'x', '> /modx');
    expect(backend.calls.filter((call) => call.startsWith('inbox:') || call.startsWith('cancel:'))).toEqual([]);
    app.unmount();
  });

  it('takes every waiting message back into the draft at Up on the first line, before the typed text, and keeps them in the history', async () => {
    const { backend, app } = await working();
    await send(backend, app, KEYS.enter, 'one more', 'queued  one more');
    await send(backend, app, KEYS.tab, 'and steer', 'steer   and steer');
    await type(app, 'draft', '> draft');
    app.stdin.write(KEYS.up);
    const shown = await untilFrame(app, (now) => inputLines(now).length === 3);
    expect(inputLines(shown)).toEqual(['> one more', '  and steer', '  draft']);
    expect(shown).not.toContain('queued  one more');
    expect(shown).not.toContain('steer   and steer');
    expect(shown).toContain(BUSY_HINT);
    expect(shown).not.toContain('take back waiting messages');
    expect(backend.calls.filter((call) => call.startsWith('inbox-withdraw:'))).toEqual(['inbox-withdraw:row-1', 'inbox-withdraw:row-2']);
    expect(backend.inboxRows.map((row) => row.state)).toEqual(['withdrawn', 'withdrawn']);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'queued  one more');
    expect(backend.calls.at(-1)).toBe('inbox:queue:one more\nand steer\ndraft');
    app.unmount();
  });

  it('does not restore a message that was delivered before the take-back', async () => {
    const { backend, app } = await working();
    await send(backend, app, KEYS.tab, 'gone to the model', 'steer   gone to the model');
    await send(backend, app, KEYS.enter, 'still waiting', 'queued  still waiting');
    backend.deliverInbox('row-1');
    app.stdin.write(KEYS.up);
    const shown = await untilFrame(app, '> still waiting');
    expect(inputLines(shown)).toEqual(['> still waiting']);
    app.unmount();
  });

  it(`answers the hint row when ${INBOX_MAX_PENDING} messages already wait, keeps the draft, and draws 5 rows and the count of the rest`, async () => {
    const { backend, app } = await working();
    for (let index = 0; index < INBOX_MAX_PENDING; index += 1) await backend.inbox.add('queue', `m${index + 1}`);
    await type(app, 'x', '> x');
    app.stdin.write(KEYS.enter);
    const shown = await untilFrame(app, (now) => now.includes('20 messages are already waiting') && now.includes('> x') && now.includes('queued  m1'));
    expect(shown).toContain('queued  m5');
    expect(shown).not.toContain('queued  m6');
    expect(shown).toContain('+15 more waiting');
    app.unmount();
  });

  it('shows a steered message in the transcript where the model received it, and takes its row away', async () => {
    const { backend, app } = await working();
    await send(backend, app, KEYS.tab, 'also the docs', 'steer   also the docs');
    backend.deliverInbox('row-1');
    backend.emit(frame({ type: 'user.message', text: 'also the docs', source: 'steer' }));
    await untilOutput(app, '> also the docs');
    await untilFrame(app, (shown) => !shown.includes('steer   also the docs'));
    app.unmount();
  });

  it('follows the run a queued message became when the working run ends, and is idle after the last one', async () => {
    const { backend, app } = await working();
    await send(backend, app, KEYS.enter, 'second task', 'queued  second task');
    backend.deliverInbox('row-1');
    backend.succeed('run-1', runView({ id: 'run-2', ordinal: 2, status: 'QUEUED', previousRunId: 'run-1' }));
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView());
    await untilFrame(app, (shown) => !shown.includes('queued  second task') && shown.includes(BUSY_HINT));
    backend.emit(frame({ runId: 'run-2', type: 'user.message', text: 'second task', source: 'queue' }));
    await untilOutput(app, '> second task');
    app.stdin.write(KEYS.escape);
    await backend.called('cancel:run-2');
    backend.emit(frame({ runId: 'run-2', type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView({ id: 'run-2', ordinal: 2 }));
    await untilFrame(app, (shown) => !shown.includes(BUSY_HINT) && shown.includes(READY));
    expect(backend.started).toHaveLength(1);
    app.unmount();
  });

  it('still runs a slash command at Enter and puts nothing in the inbox', async () => {
    const { backend, app } = await working();
    await type(app, '/mode plan', '> /mode plan');
    app.stdin.write(KEYS.enter);
    await backend.called('mode:plan');
    expect(backend.calls.filter((call) => call.startsWith('inbox:'))).toEqual([]);
    app.unmount();
  });
});
