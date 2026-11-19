import type { PublicRunEvent } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { RunEventFrame } from '../../src/client/runtime-client.ts';
import { HANDOVER_FORMAT, attachmentDigest } from '../../src/handover/record.ts';
import type { TuiRecord } from '../../src/handover/record.ts';
import { restartingText } from '../../src/handover/texts.ts';
import type { TuiMovePort, TuiSnapshot, TuiSurface } from '../../src/tui/handover.ts';
import { createBackgroundTasks } from '../../src/tui/background-tasks.ts';
import { runView } from '../fake-backend.ts';
import type { FakeBackendOptions, FakeConversation } from '../fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { frame, runStarted, start, startStillStarting, type } from '../tui-harness.tsx';
import { SCRIPTED_MODEL, waitFor, afterMicrotasks } from '@momonga/testkit';

const IDLE = /^(?![\s\S]*esc to cancel)(?![\s\S]*steer after)[\s\S]*mode: \w+ \(shift\+tab\)/;

const read = (shown: string): boolean => IDLE.test(shown) && shown.includes('All green.');
const SESSION_ID = 'aaaaaaaa11111111';
const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };

const framesOf = (runId: string, events: readonly Record<string, unknown>[]): RunEventFrame[] =>
  events.map((event, index) => ({ id: index + 1, event: String(event['type']), data: { runId, sessionId: SESSION_ID, step: 1, createdAt: 1000, id: index + 1, seq: index + 1, ...event } as PublicRunEvent }));

const ended = { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' };

const notices = (count: number): Record<string, unknown>[] => Array.from({ length: count }, (_, index) => ({ type: 'notice', level: 'info', message: `line ${index + 1} of the work` }));

const LONG: FakeConversation = {
  session: { id: SESSION_ID, createdAt: 1 },
  firstPrompt: 'fix the login bug',
  runs: [
    {
      id: 'login-1',
      frames: framesOf('login-1', [
        { type: 'user.message', text: 'fix the login bug' },
        { type: 'agent.thought.delta', attempt: 0, itemId: 't1', text: 'where is it', createdAt: 1000 },
        { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Looking.', createdAt: 3000 },
        ...notices(40),
        ended,
      ]),
    },
    { id: 'login-2', frames: framesOf('login-2', [{ type: 'user.message', text: 'and the tests' }, { type: 'agent.message.delta', attempt: 0, itemId: 'm2', text: 'All green.' }, ended]) },
  ],
};

const STREAMING: FakeConversation = {
  session: { id: SESSION_ID, createdAt: 1 },
  firstPrompt: 'list the files',
  runs: [
    {
      id: 'list-1',
      status: 'RUNNING',
      frames: framesOf('list-1', [
        { type: 'user.message', text: 'list the files' },
        { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: { command: 'ls' } },
        { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
        { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'alpha.ts' },
        { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Found two files, now checking' },
      ]),
    },
  ],
};

const moving = () => {
  const surfaces: TuiSurface[] = [];
  let checks = 0;
  const port: TuiMovePort = {
    attach: (surface) => {
      surfaces.push(surface);
      return () => undefined;
    },
    check: () => {
      checks += 1;
    },
    probe: () => undefined,
  };
  const surface = (): TuiSurface => {
    const found = surfaces.at(-1);
    if (found === undefined) throw new Error('the app attached no surface');
    return found;
  };
  return { port, surface, checks: () => checks };
};

const recordOf = (snapshot: TuiSnapshot | undefined, change: Partial<TuiRecord> = {}): TuiRecord => {
  if (snapshot === undefined) throw new Error('the app gave no snapshot');
  return { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', ...snapshot, ...change };
};

type Extra = NonNullable<Parameters<typeof start>[1]>;

const open = async (options: FakeBackendOptions, extra: Extra = {}, screen: Parameters<typeof start>[2] = {}) => {
  const move = moving();
  const started = await start(options, { ...extra, move: move.port }, screen);
  return { ...started, move };
};

const openStillStarting = async (options: FakeBackendOptions) => {
  const move = moving();
  const started = await startStillStarting(options, { move: move.port });
  return { ...started, move };
};

const adopt = async (options: FakeBackendOptions, record: TuiRecord, extra: Extra = {}, screen: Parameters<typeof start>[2] = {}) => {
  const attached = Promise.withResolvers<void>();
  const opened = await open(options, { ...extra, adoption: { record, attached: () => attached.resolve() } }, screen);
  return { ...opened, attached: attached.promise };
};

describe('the prompt on the screen comes from its event (16.2, red test 5)', () => {
  it('appears once when the event arrives', async () => {
    const { backend, app } = await open({});
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'list the files');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Two files.' }));
    const shown = await untilFrame(app, 'Two files.');
    expect(shown.split('> list the files').length - 1).toBe(1);
    app.unmount();
  });
});

describe('the quiet point of the TUI (16.5, red tests 12 and 28)', () => {
  it('is not quiet before a session is open, and is quiet when idle and while a run streams', async () => {
    const { backend, app, move } = await openStillStarting({});
    expect(move.surface().session()).toBeUndefined();
    await untilFrame(app, 'mode: manual');
    expect(move.surface().session()).toBe('session-1');
    expect(move.surface().quiet('live')).toBe(true);
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Working.' }));
    await untilFrame(app, 'Working.');
    expect(move.surface().quiet('live')).toBe(true);
    app.unmount();
  });

  it('is not quiet with an approval open, and the check is made again when it closes', async () => {
    const { backend, app, move } = await open({});
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: {} }));
    backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'commands require approval', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
    await untilFrame(app, 'Allow once');
    expect(move.surface().quiet('live')).toBe(false);
    const before = move.checks();
    backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', callId: 'c1', optionId: 'o1', decision: 'allow' }));
    await untilFrame(app, (shown) => !shown.includes('Allow once'));
    expect(move.surface().quiet('live')).toBe(true);
    expect(move.checks()).toBeGreaterThan(before);
    app.unmount();
  });

  it('is quiet with an approval open once its own generation is gone, since the approval waits in the store for the next process', async () => {
    const { backend, app, move } = await open({});
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: {} }));
    backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'commands require approval', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
    await untilFrame(app, 'Allow once');
    expect(move.surface().quiet('live')).toBe(false);
    expect(move.surface().quiet('gone')).toBe(true);
    app.unmount();
  });

  it('is not quiet with an elicitation open, even when its generation is gone', async () => {
    const { backend, app, move } = await open({});
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__remote__ask', kind: 'other', title: 'Ask', rawInput: {} }));
    backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'remote', expiresAt: 10, requests: [{ key: 'k1', mode: 'form', message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } }] }));
    await untilFrame(app, 'Which branch?');
    expect(move.surface().quiet('live')).toBe(false);
    expect(move.surface().quiet('gone')).toBe(false);
    app.unmount();
  });

  it('is not quiet while a task of its own runs, and the check is made again when it ends', async () => {
    const tasks = createBackgroundTasks();
    const { app, move } = await open({}, { tasks });
    await untilFrame(app, 'mode: manual');
    const work = Promise.withResolvers<void>();
    const running = tasks.run(() => work.promise);
    expect(move.surface().quiet('live')).toBe(false);
    const before = move.checks();
    work.resolve();
    await running;
    await waitFor(() => move.checks() > before, { description: 'the check made again when the task ended' });
    expect(move.surface().quiet('live')).toBe(true);
    expect(move.checks()).toBeGreaterThan(before);
    app.unmount();
  });

  it('is not quiet while a /tui switch is under way, and is quiet at the event that ends it', async () => {
    const { app, move, terminal } = await open({});
    await untilFrame(app, 'mode: manual');
    const during: boolean[] = [];
    const setScreen = terminal.setScreen;
    terminal.setScreen = (screen) => {
      during.push(move.surface().quiet('live'));
      setScreen(screen);
    };
    await type(app, '/tui scrollback', '> /tui scrollback');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'screen: scrollback');
    expect(during).toEqual([false]);
    expect(move.surface().quiet('live')).toBe(true);
    app.unmount();
  });
});

describe('what the old process puts in the record, and what the new one restores (16.3, 16.4)', () => {
  it('keeps the local notes in order at their anchors, the unsent input and the negotiation state (red tests 7 and 11)', async () => {
    const old = await open({ conversations: [LONG], history: ['first', 'second'] }, { reopen: { kind: 'id', id: SESSION_ID } });
    await untilFrame(old.app, read);
    old.terminal.negotiate('kitty');
    await type(old.app, '/nope', '> /nope');
    old.app.stdin.write(KEYS.enter);
    await untilFrame(old.app, 'unknown command /nope');
    old.move.surface().say('a note of the mover');
    await type(old.app, 'half a prompt', '> half a prompt');
    old.terminal.emit({ type: 'key', name: 'left', ...plain });
    old.terminal.emit({ type: 'key', name: 'left', ...plain });
    const snapshot = old.move.surface().snapshot();
    old.app.unmount();

    expect(snapshot).toMatchObject({
      kind: 'tui',
      session: SESSION_ID,
      lastSeq: { 'login-1': 44, 'login-2': 3 },
      neg: 'kitty',
      hint: 'shift+enter',
      size: { columns: 160, rows: 100 },
      input: { text: 'half a prompt', cursor: 11, historyIndex: null },
      attachments: [],
      notes: [
        { anchor: { runId: 'login-2', seq: 3 }, kind: 'info', level: 'info', text: 'unknown command /nope; /help lists the commands' },
        { anchor: { runId: 'login-2', seq: 3 }, kind: 'info', level: 'info', text: 'a note of the mover' },
      ],
    });
    expect(snapshot).not.toHaveProperty('printed');

    const fresh = await adopt({ conversations: [LONG], history: ['first', 'second'] }, recordOf(snapshot));
    fresh.terminal.negotiate('kitty');
    await fresh.attached;
    const shown = await untilFrame(fresh.app, '> half a prompt');
    expect(shown.indexOf('All green.')).toBeLessThan(shown.indexOf('unknown command /nope'));
    expect(shown.indexOf('unknown command /nope')).toBeLessThan(shown.indexOf('a note of the mover'));
    expect(fresh.backend.calls).toContain(`resume:${SESSION_ID}`);
    expect(fresh.move.surface().snapshot()).toEqual(snapshot);
    fresh.terminal.emit({ type: 'key', text: 'X', ...plain });
    await untilFrame(fresh.app, 'half a promXpt');
    fresh.app.unmount();
  });

  it('puts a note that sits between two runs back between them', async () => {
    const record = recordOf({
      kind: 'tui',
      session: SESSION_ID,
      lastSeq: { 'login-1': 44, 'login-2': 3 },
      neg: 'unknown',
      hint: 'ctrl+j',
      size: { columns: 160, rows: 100 },
      view: { key: null, rowOffset: 0, following: true },
      toggles: { thoughts: {} },
      input: { text: '', cursor: 0, historyIndex: null, draft: '', pastes: [], pasteCount: 0 },
      attachments: [],
      notes: [{ anchor: { runId: 'login-1', seq: 44 }, kind: 'notice', level: 'warning', text: 'model information unavailable: offline' }],
    });
    const fresh = await adopt({ conversations: [LONG] }, record);
    await fresh.attached;
    const shown = await untilFrame(fresh.app, 'All green.');
    expect(shown.indexOf('line 40 of the work')).toBeLessThan(shown.indexOf('model information unavailable: offline'));
    expect(shown.indexOf('model information unavailable: offline')).toBeLessThan(shown.indexOf('> and the tests'));
    fresh.app.unmount();
  });

  it('never sends the initial prompt, images or skill again (red test 9)', async () => {
    const old = await open({ conversations: [LONG] }, { reopen: { kind: 'id', id: SESSION_ID } });
    await untilFrame(old.app, read);
    const record = recordOf(old.move.surface().snapshot());
    old.app.unmount();
    const fresh = await adopt({ conversations: [LONG] }, record, { initialPrompt: 'fix the login bug', initialSkill: 'review', initialImages: ['/work/a.png'] });
    await fresh.attached;
    await untilFrame(fresh.app, IDLE);
    expect(fresh.backend.started).toEqual([]);
    expect(fresh.backend.calls).not.toContain('openSession');
    fresh.app.unmount();
  });

  it('attaches a file again when its digest is the same, and drops a changed or missing one with a notice (red test 10)', async () => {
    const kept = { mediaType: 'image/png' as const, data: 'a2VwdA==' };
    const changed = { mediaType: 'image/png' as const, data: 'bmV3' };
    const old = await open({ conversations: [LONG] }, { reopen: { kind: 'id', id: SESSION_ID } });
    await untilFrame(old.app, read);
    const record = recordOf(old.move.surface().snapshot(), {
      attachments: [
        { file: '/work/kept.png', sha256: attachmentDigest(kept) },
        { file: '/work/changed.png', sha256: attachmentDigest({ mediaType: 'image/png', data: 'b2xk' }) },
        { file: '/work/gone.png', sha256: attachmentDigest(kept) },
      ],
    });
    old.app.unmount();
    const fresh = await adopt({ conversations: [LONG], imageInput: true, images: { '/work/kept.png': kept, '/work/changed.png': changed } }, record);
    await fresh.attached;
    const shown = await untilFrame(fresh.app, 'gone.png');
    expect(shown).toContain('The attached file /work/changed.png has changed and was dropped.');
    expect(shown).toContain('The attached file /work/gone.png could not be read and was dropped (no such image /work/gone.png).');
    expect(fresh.move.surface().snapshot()?.attachments).toEqual([{ file: '/work/kept.png', sha256: attachmentDigest(kept) }]);
    fresh.app.unmount();
  });
});

describe('the fullscreen view across the move (16.6, red tests 21, 22 and 23)', () => {
  const SMALL = { columns: 80, rows: 24 };

  const scrolledUp = async () => {
    const old = await open({ conversations: [LONG] }, { reopen: { kind: 'id', id: SESSION_ID } }, SMALL);
    await untilFrame(old.app, read);
    old.terminal.emit({ type: 'key', name: 'pageup', ...plain });
    old.terminal.emit({ type: 'key', name: 'pageup', ...plain });
    const frameBefore = await untilFrame(old.app, (shown) => !shown.includes('All green.'));
    return { old, frameBefore };
  };

  it('shows the same rows at the same anchor with the same following state, and each thought as recorded', async () => {
    const { old, frameBefore } = await scrolledUp();
    const snapshot = old.move.surface().snapshot();
    old.app.unmount();
    expect(snapshot?.view).toMatchObject({ following: false, key: { runId: 'login-1' } });
    expect(snapshot?.toggles).toEqual({ thoughts: { t1: false } });

    const fresh = await adopt({ conversations: [LONG] }, recordOf(snapshot), {}, SMALL);
    await fresh.attached;
    expect(await untilFrame(fresh.app, IDLE)).toBe(frameBefore);
    expect(fresh.move.surface().snapshot()?.view).toEqual(snapshot?.view);
    fresh.app.unmount();

    const opened = await adopt({ conversations: [LONG] }, recordOf(snapshot, { view: { key: null, rowOffset: 0, following: false }, toggles: { thoughts: { t1: true } } }), {}, SMALL);
    await opened.attached;
    expect(await untilFrame(opened.app, 'where is it')).toContain('Thought for');
    expect(opened.move.surface().snapshot()?.toggles).toEqual({ thoughts: { t1: true } });
    opened.app.unmount();
  });

  it('follows the end when the record followed it', async () => {
    const old = await open({ conversations: [LONG] }, { reopen: { kind: 'id', id: SESSION_ID } }, SMALL);
    const frameBefore = await untilFrame(old.app, read);
    const snapshot = old.move.surface().snapshot();
    old.app.unmount();
    expect(snapshot?.view?.following).toBe(true);
    const fresh = await adopt({ conversations: [LONG] }, recordOf(snapshot), {}, SMALL);
    await fresh.attached;
    expect(await untilFrame(fresh.app, IDLE)).toBe(frameBefore);
    fresh.app.unmount();
  });

  it('writes nothing while it prepares the move, and draws again when the move failed', async () => {
    const { old } = await scrolledUp();
    const written = old.app.frames.length;
    await old.move.surface().suspend();
    old.move.surface().say(restartingText('1.2.4'));
    await afterMicrotasks();
    expect(old.app.frames.length).toBe(written);
    old.move.surface().resume();
    old.terminal.emit({ type: 'key', name: 'end', ctrl: true, alt: false, shift: false, super: false, hyper: false, meta: false });
    await untilFrame(old.app, restartingText('1.2.4'));
    old.app.unmount();
  });

  it('keeps the entry and the following state through a resize between the record and the adoption, and draws a complete frame', async () => {
    const { old } = await scrolledUp();
    const snapshot = old.move.surface().snapshot();
    old.app.unmount();
    const fresh = await adopt({ conversations: [LONG] }, recordOf(snapshot), {}, { columns: 50, rows: 16 });
    await fresh.attached;
    const shown = await untilFrame(fresh.app, IDLE);
    const view = fresh.move.surface().snapshot()?.view;
    expect(view?.key).toEqual(snapshot?.view?.key);
    expect(view?.following).toBe(false);
    expect(shown.split('\n').length).toBe(16);
    expect(fresh.move.surface().snapshot()?.size).toEqual({ columns: 50, rows: 16 });
    fresh.app.unmount();
  });
});

describe('the events of a child run take their own anchor (P-309)', () => {
  it('records the child run in the applied sequence and anchors a note made after a child event to that event', async () => {
    const old = await open({ conversations: [STREAMING] }, { reopen: { kind: 'id', id: SESSION_ID } });
    await untilFrame(old.app, 'Found two files, now checking');
    const [child] = framesOf('helper-1', [{ type: 'agent.message.delta', attempt: 0, itemId: 'h1', text: 'the helper looked' }]);
    if (child === undefined) throw new Error('no child frame');
    old.backend.following().onChildEvent(child, 'helper');
    await vi.waitFor(() => expect(old.move.surface().snapshot()?.lastSeq).toEqual({ 'list-1': 5, 'helper-1': 1 }), { timeout: 2000 });
    old.move.surface().say('a note after the helper');
    const snapshot = old.move.surface().snapshot();
    old.app.unmount();
    expect(snapshot?.notes).toEqual([{ anchor: { runId: 'helper-1', seq: 1 }, kind: 'info', level: 'info', text: 'a note after the helper' }]);
  });
});

describe('the scrollback output across the move (16.6, red test 8)', () => {
  it('prints no settled item twice: the first printed items are skipped and the rest is the live region', async () => {
    const old = await open({ conversations: [STREAMING] }, { reopen: { kind: 'id', id: SESSION_ID } }, { screen: 'scrollback' });
    await untilFrame(old.app, 'Found two files, now checking');
    await untilOutput(old.app, '> list the files');
    await vi.waitFor(() => expect(old.move.surface().quiet('live')).toBe(true), { timeout: 5000 });
    await old.move.surface().suspend();
    const snapshot = old.move.surface().snapshot();
    old.app.unmount();
    expect(snapshot?.printed).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty('view');
    expect(snapshot).not.toHaveProperty('toggles');

    const fresh = await adopt({ conversations: [STREAMING] }, recordOf(snapshot), {}, { screen: 'scrollback' });
    await fresh.attached;
    await untilFrame(fresh.app, 'Found two files, now checking');
    const output = fresh.app.frames.join('\n');
    expect(output).not.toContain('> list the files');
    expect(output).not.toContain('Bash ls');
    expect(fresh.move.surface().snapshot()?.printed).toBe(snapshot?.printed);
    fresh.app.unmount();
  });
});

describe('a handover while a subagent view is shown (cli-tui 3.3)', () => {
  it('records the main view at its end, and the new process shows the main conversation, never the child view', async () => {
    const old = await open({ conversations: [STREAMING] }, { reopen: { kind: 'id', id: SESSION_ID } });
    await untilFrame(old.app, 'Found two files, now checking');
    const follow = old.backend.following();
    follow.onChildStarted('reviewer', 'child-1', 0, SCRIPTED_MODEL, undefined);
    follow.onChildEvent({ id: 1, event: 'agent.message.delta', data: { runId: 'child-1', sessionId: SESSION_ID, step: 1, createdAt: 1000, id: 1, seq: 1, type: 'agent.message.delta', attempt: 0, itemId: 'c1', text: 'child words' } as PublicRunEvent }, 'reviewer');
    await untilFrame(old.app, 'reviewer · starting');
    old.terminal.emit({ type: 'key', name: 'down', ...plain });
    old.terminal.emit({ type: 'key', name: 'down', ...plain });
    old.terminal.emit({ type: 'key', name: 'enter', ...plain });
    await untilFrame(old.app, 'child words');
    const snapshot = old.move.surface().snapshot();
    old.app.unmount();
    expect(snapshot).toMatchObject({ view: { following: true } });
    const fresh = await adopt({ conversations: [STREAMING] }, recordOf(snapshot));
    await fresh.attached;
    const shown = await untilFrame(fresh.app, 'Found two files, now checking');
    expect(shown).not.toContain('child words');
    expect(shown).not.toContain('Subagent reviewer');
    fresh.app.unmount();
  });
});
