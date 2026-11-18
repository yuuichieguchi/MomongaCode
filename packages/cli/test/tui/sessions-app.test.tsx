import { describe, expect, it, vi } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame } from '../../src/client/runtime-client.ts';
import { RESUME_PICKER_TITLE, conversationRow } from '../../src/tui/commands/resume.ts';
import { runView } from '../fake-backend.ts';
import type { FakeConversation } from '../fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { runStarted, start, type } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';
import { turnTimers } from './turn-timers.ts';
import { SESSION } from '../fake-backend.ts';
import { describeRunEnd } from '../../src/run/headless.ts';

const NOW = 10_000_000_000;
const HOUR = 3_600_000;
const IDLE = /^(?![\s\S]*esc to cancel)[\s\S]*mode: \w+ \(shift\+tab\)/;
const QWEN = 'ollama/qwen3.8:27b';
const ERASE_SCROLLBACK = '\u001b[3J';
const ERASE_SCREEN = '\u001b[2J\u001b[H';

const framesOf = (runId: string, events: readonly Record<string, unknown>[]): RunEventFrame[] =>
  events.map((event, index) => ({ id: index + 1, event: String(event['type']), data: { runId, sessionId: 's', step: 1, createdAt: 1000, id: index + 1, seq: index + 1, ...event } as PublicRunEvent }));

const ended = { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' };

const LOGIN: FakeConversation = {
  session: { id: 'aaaaaaaa11111111', createdAt: NOW - 2 * HOUR, permissionMode: 'acceptEdits', model: SESSION.model },
  firstPrompt: 'fix the login bug',
  runs: [
    {
      id: 'login-1',
      frames: framesOf('login-1', [
        { type: 'user.message', text: 'fix the login bug' },
        { type: 'agent.thought.delta', attempt: 0, itemId: 't1', text: 'where is it', createdAt: 1000 },
        { type: 'user.message', text: 'injected by a hook' },
        { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'It is fixed.', createdAt: 3000 },
        ended,
      ]),
    },
  ],
};

const TESTS: FakeConversation = {
  session: { id: 'bbbbbbbb22222222', createdAt: NOW - 72 * HOUR },
  firstPrompt: 'add tests',
  runs: [
    { id: 'tests-1', frames: framesOf('tests-1', [{ type: 'user.message', text: 'add tests' }, { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Three tests added.' }, ended]) },
    { id: 'tests-2', frames: framesOf('tests-2', [{ type: 'user.message', text: 'one more' }, { type: 'agent.message.delta', attempt: 0, itemId: 'm2', text: 'A fourth test added.' }, ended]) },
  ],
};

const conversations = [TESTS, LOGIN];

const enter = async (app: Parameters<typeof type>[0], text: string): Promise<void> => {
  await type(app, text, `> ${text}`);
  app.stdin.write(KEYS.enter);
};

describe('reopening a session from the shell (9.1, 9.2)', () => {
  it('--resume <id> opens that session with its mode and shows its conversation with every thought folded', async () => {
    const { app, backend } = await start({ conversations }, { reopen: { kind: 'id', id: 'aaaaaaaa' }, now: () => NOW });
    const shown = await untilFrame(app, 'It is fixed.');

    expect(shown).toContain('> fix the login bug');
    expect(shown).toContain('Thought for 2s');
    expect(shown).not.toContain('where is it');
    expect(shown).not.toContain('injected by a hook');
    await untilFrame(app, 'mode: acceptEdits (shift+tab)');
    expect(backend.calls).toContain('resume:aaaaaaaa');
    expect(backend.calls).not.toContain('openSession');
    app.unmount();
  });

  it('--resume <id> shows every run of the session in order', async () => {
    const { app } = await start({ conversations }, { reopen: { kind: 'id', id: 'bbbbbbbb22222222' }, now: () => NOW });
    const shown = await untilFrame(app, 'A fourth test added.');

    expect(shown.indexOf('> add tests')).toBeLessThan(shown.indexOf('Three tests added.'));
    expect(shown.indexOf('Three tests added.')).toBeLessThan(shown.indexOf('> one more'));
    app.unmount();
  });

  it('--continue opens the newest session of this folder', async () => {
    const { app, backend } = await start({ conversations }, { reopen: { kind: 'newest' }, now: () => NOW });

    await untilFrame(app, 'It is fixed.');
    expect(backend.calls).toContain('continue');
    app.unmount();
  });

  it('refuses an id no session has and leaves with that reason', async () => {
    const { app, exited } = await start({ conversations }, { reopen: { kind: 'id', id: 'ffffffff' }, now: () => NOW });

    expect((await exited).error?.message).toBe('No session has the id ffffffff.');
    app.unmount();
  });

  it('--resume without an id opens the session picker', async () => {
    const { app } = await start({ conversations }, { reopen: { kind: 'pick' }, now: () => NOW });
    const shown = await untilFrame(app, RESUME_PICKER_TITLE);

    expect(shown).toContain('1. fix the login bug · 2h ago · 1 run');
    expect(shown).toContain('2. add tests · 3d ago · 2 runs');
    app.unmount();
  });

  it('follows a run that is still open after the conversation is read', async () => {
    const open: FakeConversation = { session: { id: 'cccccccc33333333', createdAt: NOW }, firstPrompt: 'long task', runs: [{ id: 'open-1', status: 'RUNNING', frames: framesOf('open-1', [{ type: 'user.message', text: 'long task' }, { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Working' }]) }] };
    const { app, backend } = await start({ conversations: [open] }, { reopen: { kind: 'id', id: 'cccccccc' }, now: () => NOW });

    await untilFrame(app, 'Working');
    backend.emit({ id: 3, event: 'agent.message.delta', data: { runId: 'open-1', sessionId: 's', step: 1, createdAt: 1000, id: 3, seq: 3, type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: ' on it still.' } as PublicRunEvent });
    await untilFrame(app, 'Working on it still.');
    backend.finish(runView({ id: 'open-1' }));
    await untilFrame(app, IDLE);
    app.unmount();
  });

  it('follows the queued run that follows the open run of a reopened conversation (P-222)', async () => {
    const open: FakeConversation = { session: { id: 'cccccccc33333333', createdAt: NOW }, firstPrompt: 'long task', runs: [{ id: 'open-1', status: 'RUNNING', frames: framesOf('open-1', [{ type: 'user.message', text: 'long task' }]) }] };
    const { app, backend } = await start({ conversations: [open] }, { reopen: { kind: 'id', id: 'cccccccc' }, now: () => NOW });
    await untilFrame(app, 'long task');
    backend.succeed('open-1', runView({ id: 'next-2', ordinal: 2, status: 'QUEUED', previousRunId: 'open-1' }));
    backend.finish(runView({ id: 'open-1' }));
    await vi.waitFor(() => expect(backend.followed).toContain('next-2'));
    backend.emit({ id: 1, event: 'user.message', data: { runId: 'next-2', sessionId: 's', step: 1, createdAt: 1000, id: 1, seq: 1, type: 'user.message', text: 'queued after', source: 'queue' } as PublicRunEvent });
    await untilOutput(app, '> queued after');
    app.unmount();
  });

  it('shows the end of a past run that did not complete, from its record (P-215)', async () => {
    const failed: FakeConversation = { session: { id: 'eeeeeeee55555555', createdAt: NOW }, firstPrompt: 'broken', runs: [{ id: 'failed-1', status: 'FAILED', frames: framesOf('failed-1', [{ type: 'user.message', text: 'broken' }]) }] };
    const { app } = await start({ conversations: [failed] }, { reopen: { kind: 'id', id: 'eeeeeeee' }, now: () => NOW });
    await untilFrame(app, describeRunEnd(runView({ id: 'failed-1', status: 'FAILED', lastSeq: 1 }), 'tui'));
    app.unmount();
  });
});

describe('/resume (9.1, 4.3)', () => {
  it('lists the sessions of this folder newest first, filters by typing and opens the chosen one', async () => {
    const { app, backend } = await start({ conversations }, { now: () => NOW });
    await untilFrame(app, 'mode: manual');
    await enter(app, '/resume');
    const listed = await untilFrame(app, RESUME_PICKER_TITLE);
    expect(listed.indexOf('fix the login bug · 2h ago · 1 run')).toBeLessThan(listed.indexOf('add tests · 3d ago · 2 runs'));
    expect(listed).toContain('type to filter');

    app.stdin.write('tests');
    const filtered = await untilFrame(app, (frame) => frame.includes('add tests') && !frame.includes('fix the login bug'));
    expect(filtered).toContain('add tests · 3d ago · 2 runs');
    app.stdin.write(KEYS.enter);

    await untilFrame(app, 'A fourth test added.');
    expect(backend.calls).toContain('resume:bbbbbbbb22222222');
    app.unmount();
  });

  it('/resume <id> opens that session, and an unknown id is refused in the transcript', async () => {
    const { app } = await start({ conversations }, { now: () => NOW });
    await untilFrame(app, 'mode: manual');
    await enter(app, '/resume ffffffff');
    await untilFrame(app, 'No session has the id ffffffff.');
    await enter(app, '/resume aaaaaaaa');
    await untilFrame(app, 'It is fixed.');
    app.unmount();
  });

  it('says so when this folder has no earlier conversation', async () => {
    const { app } = await start({}, { now: () => NOW });
    await untilFrame(app, 'mode: manual');
    await enter(app, '/resume');
    await untilFrame(app, 'No earlier conversation in /work/project.');
    app.unmount();
  });

  it('is refused while a task runs', async () => {
    const { app, backend } = await start({ conversations }, { now: () => NOW });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    await enter(app, '/resume aaaaaaaa');
    await untilFrame(app, 'A run is working. Esc stops it.');
    expect(backend.calls).not.toContain('resume:aaaaaaaa');
    app.unmount();
  });

  it('cuts the first prompt so the age and the number of runs stay in the row', () => {
    expect(conversationRow({ id: 'x', createdAt: NOW - 2 * HOUR, runs: 3, firstPrompt: 'a'.repeat(100) }, NOW, 40)).toBe(`${'a'.repeat(13)}… · 2h ago · 3 runs`);
    expect(conversationRow({ id: 'x', createdAt: NOW - 30_000, runs: 1, firstPrompt: 'two\nlines' }, NOW, 80)).toBe('two lines · just now · 1 run');
    expect(conversationRow({ id: 'x', createdAt: NOW - 5 * 60_000, runs: 1, firstPrompt: 'short' }, NOW, 80)).toBe('short · 5m ago · 1 run');
  });
});

describe('the session named at exit (9.3)', () => {
  it('names the session after at least one message', async () => {
    const { app, backend, exited } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.finish(runView());
    await untilFrame(app, IDLE);
    await enter(app, '/exit');

    expect(await exited).toEqual({ reopen: 'session-1' });
    app.unmount();
  });

  it('names no session when nothing was sent', async () => {
    const { app, exited } = await start();
    await untilFrame(app, 'mode: manual');
    await enter(app, '/exit');

    expect(await exited).toEqual({});
    app.unmount();
  });

  it('names a reopened session that has a run', async () => {
    const { app, exited } = await start({ conversations }, { reopen: { kind: 'id', id: 'aaaaaaaa' }, now: () => NOW });
    await untilFrame(app, 'It is fixed.');
    await untilFrame(app, IDLE);
    await enter(app, '/exit');

    expect(await exited).toEqual({ reopen: 'aaaaaaaa11111111' });
    app.unmount();
  });
});

describe('/clear (9.4)', () => {
  it.each(['fullscreen', 'scrollback'] as const)('opens a new session with the current mode and model, keeps the old one reopenable and never erases the scrollback (%s)', async (screen) => {
    const { app, backend, exited } = await start({ models: [SESSION.model, QWEN] }, { now: () => 300_001 }, { screen });
    await untilFrame(app, 'mode: manual');
    await enter(app, '/mode acceptEdits');
    await untilFrame(app, 'mode: acceptEdits');
    await enter(app, '/model qwen3.8:27b');
    await backend.called(`model:${QWEN}`);
    await runStarted(backend, app, 'first task');
    backend.finish(runView());
    await untilFrame(app, IDLE);

    await enter(app, '/clear');
    await untilFrame(app, (frame) => screen === 'scrollback' || !frame.includes('> first task'));
    await untilFrame(app, IDLE);
    expect(backend.opened[1]).toEqual({ model: QWEN, permissionMode: 'acceptEdits' });
    expect(app.frames.join('')).not.toContain(ERASE_SCROLLBACK);
    expect(app.frames.join('').includes(ERASE_SCREEN)).toBe(screen === 'scrollback');

    await enter(app, '/resume');
    await untilFrame(app, '1. first task · 5m ago · 1 run');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, IDLE);
    await runStarted(backend, app, 'second task');
    expect(backend.started.at(-1)).toEqual({ text: 'second task' });
    backend.finish(runView());
    await untilFrame(app, IDLE);
    await enter(app, '/exit');
    expect(await exited).toEqual({ reopen: 'session-2' });
    app.unmount();
  });

  it('is refused while a task runs', async () => {
    const { app, backend } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    await enter(app, '/clear');
    await untilFrame(app, 'A run is working. Esc stops it.');
    expect(backend.opened.length).toBe(1);
    app.unmount();
  });
});

describe('reading a long conversation (9.2, 14.1, 14.2)', () => {
  it('folds 500 events per turn with the waiting row counting them', async () => {
    const time = manualClock(NOW);
    const clock = turnTimers(time);
    const events = [{ type: 'user.message', text: 'long ago' }, { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'the first answer' }, ...Array.from({ length: 1196 }, () => ({ type: 'usage.updated', inputTokens: 1, outputTokens: 1, totalTokens: 2 })), { type: 'agent.message.delta', attempt: 0, itemId: 'm2', text: 'the last answer' }, ended];
    const long: FakeConversation = { session: { id: 'dddddddd44444444', createdAt: NOW }, firstPrompt: 'long ago', runs: [{ id: 'long-1', frames: framesOf('long-1', events) }] };
    const { app } = await start({ conversations: [long] }, { reopen: { kind: 'id', id: 'dddddddd' }, now: time.now, timers: clock.timers });

    const before = await untilFrame(app, '⠋ loading the conversation 0 of 1200 events 0s');
    expect(before).not.toContain('> long ago');
    clock.turn();
    const first = await untilFrame(app, 'loading the conversation 500 of 1200 events');
    expect(first).toContain('the first answer');
    expect(first).not.toContain('the last answer');
    clock.turn();
    await untilFrame(app, 'loading the conversation 1000 of 1200 events');
    clock.turn();
    const read = await untilFrame(app, (frame) => !frame.includes('loading the conversation') && frame.includes('the last answer'));
    expect(read).toMatch(IDLE);
    app.unmount();
  });
});
