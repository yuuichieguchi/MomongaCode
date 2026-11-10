import { describe, expect, it, vi } from 'vitest';
import type { UserShellEnd } from '../../src/client/runtime-client.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { runStarted, start, type } from '../tui-harness.tsx';

const READY = 'mode: manual (shift+tab)';
const WIDE = { columns: 120, rows: 40 };
const SHELL_HINT = '! shell: output goes to the model · !! keeps it out · enter runs · esc leaves';
const TASK_RUNNING = 'A task is running. Esc stops it.';

const inputLines = (shown: string): string[] =>
  shown
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.replace(/^│ /, '').replace(/\s*│$/, ''));

const ready = async (options: FakeBackendOptions = {}) => {
  const started = await start(options, {}, WIDE);
  await untilFrame(started.app, READY);
  return started;
};

const shellCalls = (calls: readonly string[]): string[] => calls.filter((call) => call.startsWith('shell'));

describe('the shell mode of the prompt (design 5.9)', () => {
  it('is entered by ! on an empty draft: the box shows the prefix ! and the hint row names what it does', async () => {
    const { app } = await ready();
    expect(app.lastFrame()).not.toContain(SHELL_HINT);
    app.stdin.write('!');
    const shown = await untilFrame(app, SHELL_HINT);
    expect(inputLines(shown)[0]).toBe('!');
    await type(app, 'ls -la', '! ls -la');
    app.unmount();
  });

  it('is left by Backspace on an empty draft with nothing run', async () => {
    const { app, backend } = await ready();
    app.stdin.write('!');
    await untilFrame(app, SHELL_HINT);
    app.stdin.write(KEYS.backspace);
    const shown = await untilFrame(app, (now) => !now.includes(SHELL_HINT));
    expect(inputLines(shown)[0]).toBe('>');
    expect(shellCalls(backend.calls)).toEqual([]);
    app.unmount();
  });

  it('is left by Esc with nothing run, and the typed text stays as a chat draft', async () => {
    const { app, backend } = await ready();
    await type(app, '!ls', '! ls');
    app.stdin.write(KEYS.escape);
    const shown = await untilFrame(app, (now) => !now.includes(SHELL_HINT));
    expect(inputLines(shown)[0]).toBe('> ls');
    expect(shellCalls(backend.calls)).toEqual([]);
    app.unmount();
  });

  it('is not entered by a ! later in a draft', async () => {
    const { app } = await ready();
    await type(app, 'wow!', '> wow!');
    expect(app.lastFrame()).not.toContain(SHELL_HINT);
    app.unmount();
  });
});

describe('running a command the person typed', () => {
  it('runs !command for the model at Enter, shows its output under it, and starts no model turn', async () => {
    const { app, backend } = await ready();
    await type(app, '!ls', '! ls');
    app.stdin.write(KEYS.enter);
    const shown = await untilFrame(app, (now) => now.includes('✓ ! ls') && now.includes('out of ls'));
    expect(shellCalls(backend.calls)).toEqual(['shell:!:ls']);
    expect(backend.started).toEqual([]);
    expect(backend.recorded).toEqual(['!ls']);
    expect(inputLines(shown)[0]).toBe('>');
    expect(shown).not.toContain(SHELL_HINT);
    app.unmount();
  });

  it('runs !!command with its output kept out of the conversation', async () => {
    const { app, backend } = await ready();
    await type(app, '!!cat notes.txt', '! !cat notes.txt');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (now) => now.includes('✓ !! cat notes.txt') && now.includes('out of cat notes.txt'));
    expect(shellCalls(backend.calls)).toEqual(['shell:!!:cat notes.txt']);
    app.unmount();
  });

  it('does nothing at Enter when only the mark is typed', async () => {
    const { app, backend } = await ready();
    app.stdin.write('!');
    await untilFrame(app, SHELL_HINT);
    app.stdin.write(KEYS.enter);
    await type(app, 'x', '! x');
    expect(shellCalls(backend.calls)).toEqual([]);
    app.unmount();
  });

  it('shows a failing exit code, and why a refused command was not run', async () => {
    const failing = await ready({ shell: async (command, include) => ({ kind: 'exit', record: { command, exitCode: 2, output: 'no rule to make target', include } }) });
    await type(failing.app, '!make', '! make');
    failing.app.stdin.write(KEYS.enter);
    await untilFrame(failing.app, (now) => now.includes('✗ ! make (exit 2)') && now.includes('no rule to make target'));
    failing.app.unmount();

    const refusing = await ready({ shell: async () => ({ kind: 'refused', reason: 'denied by rule Bash(rm:*) (user: settings)' }) });
    await type(refusing.app, '!rm -rf x', '! rm -rf x');
    refusing.app.stdin.write(KEYS.enter);
    await untilFrame(refusing.app, (now) => now.includes('✗ ! rm -rf x') && now.includes('not run: denied by rule Bash(rm:*) (user: settings)'));
    refusing.app.unmount();
  });

  it('keeps the draft and says a task is running when Enter is pressed while a model turn works', async () => {
    const { app, backend } = await ready();
    await runStarted(backend, app, 'one');
    await type(app, '!ls', '! ls');
    app.stdin.write(KEYS.enter);
    const shown = await untilFrame(app, TASK_RUNNING);
    expect(inputLines(shown)[0]).toBe('! ls');
    expect(shellCalls(backend.calls)).toEqual([]);
    expect(backend.calls.filter((call) => call.startsWith('inbox:'))).toEqual([]);
    app.stdin.write(KEYS.tab);
    await type(app, 'x', '! lsx');
    expect(backend.calls.filter((call) => call.startsWith('inbox:'))).toEqual([]);
    app.unmount();
  });

  it('stops the running command at Esc and shows it as interrupted; a message typed meanwhile waits', async () => {
    const ended = Promise.withResolvers<UserShellEnd>();
    const { app, backend } = await ready({ shell: (_command, _include, onOutput) => (onOutput('started\n'), ended.promise) });
    await type(app, '!sleep 600', '! sleep 600');
    app.stdin.write(KEYS.enter);
    const running = await untilFrame(app, (now) => now.includes('! sleep 600') && now.includes('started') && now.includes('running ! sleep 600'));
    expect(running).toContain('esc');

    await type(app, 'hello', '> hello');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, TASK_RUNNING);
    expect(backend.started).toEqual([]);

    app.stdin.write(KEYS.escape);
    await vi.waitFor(() => expect(backend.calls).toContain('shell-stop'));
    ended.resolve({ kind: 'exit', record: { command: 'sleep 600', exitCode: null, output: 'started\n[terminated by SIGTERM]', include: true } });
    await untilFrame(app, (now) => now.includes('✗ ! sleep 600 (interrupted)') && !now.includes('running ! sleep 600'));
    app.unmount();
  });

  it('recalls the command from the history with its mark', async () => {
    const { app } = await ready();
    await type(app, '!ls', '! ls');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, '✓ ! ls');
    app.stdin.write(KEYS.up);
    const shown = await untilFrame(app, SHELL_HINT);
    expect(inputLines(shown)[0]).toBe('! ls');
    app.unmount();
  });
});

describe('a reopened session', () => {
  it('shows the commands typed after the last message', async () => {
    const conversation = {
      session: { id: 'cccccccc33333333' },
      firstPrompt: 'first',
      runs: [
        {
          id: 'c-1',
          frames: [
            { id: 1, event: 'user.message', data: { runId: 'c-1', sessionId: 's', step: 1, createdAt: 1, id: 1, seq: 1, type: 'user.message' as const, text: 'first', shell: [{ command: 'git status', exitCode: 0, output: 'clean', include: true }] } },
            { id: 2, event: 'run.status', data: { runId: 'c-1', sessionId: 's', step: 1, createdAt: 2, id: 2, seq: 2, type: 'run.status' as const, from: 'RUNNING' as const, to: 'COMPLETED' as const } },
          ],
        },
      ],
    };
    const { app } = await start({ conversations: [conversation], pendingShell: [{ command: 'cat notes', exitCode: 0, output: 'private', include: false }] }, { reopen: { kind: 'id', id: 'cccccccc' } }, WIDE);
    const shown = await untilFrame(app, (now) => now.includes('✓ !! cat notes') && now.includes('✓ ! git status'));
    expect(shown.indexOf('✓ ! git status')).toBeLessThan(shown.indexOf('> first'));
    expect(shown.indexOf('> first')).toBeLessThan(shown.indexOf('✓ !! cat notes'));
    app.unmount();
  });
});
