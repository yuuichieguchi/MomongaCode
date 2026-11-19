import { describe, expect, it, vi } from 'vitest';
import { EXIT_ARM_MS, exitHint } from '../../src/tui/app.tsx';
import { createBackgroundTasks } from '../../src/tui/background-tasks.ts';
import { BUILTIN_SLASH_COMMANDS, createSlashRegistry } from '../../src/tui/slash.ts';
import type { SlashCommand, SlashContext } from '../../src/tui/slash.ts';
import type { TuiOutcome } from '../../src/tui/app.tsx';
import type { FakeBackend } from '../fake-backend.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { runStarted, start, type } from '../tui-harness.tsx';
import { PLAN_TEST_TIMEOUT_MS } from '../fake-plan-gateway.tsx';
import { manualClock } from './screen-clock.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const HINT = exitHint('ctrl+c');
const EXIT_BOUND_MS = 3000;

type Background = <T>(label: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

const cancels = (backend: FakeBackend): number => backend.calls.filter((call) => call === 'cancel:run-1').length;

const exitedOnce = (outcomes: readonly TuiOutcome[]): Promise<void> =>
  vi.waitFor(
    () => {
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).not.toHaveProperty('error');
    },
    { timeout: EXIT_BOUND_MS },
  );

const workingRun = async () => {
  const clock = manualClock();
  const started = await start({}, { now: clock.now, timers: clock.timers });
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'long work');
  await untilFrame(started.app, 'esc to cancel');
  return { ...started, clock };
};

describe('ctrl+c while a run is working arms the exit as it cancels', () => {
  it('cancels the run once at the first press, shows the hint, and exits at a second press within the window', async () => {
    const { app, backend, outcomes, clock } = await workingRun();
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    expect(outcomes).toEqual([]);
    clock.advance(EXIT_ARM_MS - 1);
    app.stdin.write(KEYS.ctrlC);
    await exitedOnce(outcomes);
    expect(cancels(backend)).toBe(1);
    app.unmount();
  });

  it('after the window a press does not exit: it cancels again and arms again, and the press after it exits', async () => {
    const { app, backend, outcomes, clock } = await workingRun();
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, HINT);
    clock.advance(EXIT_ARM_MS);
    await untilFrame(app, (shown) => !shown.includes(HINT));
    app.stdin.write(KEYS.ctrlC);
    await vi.waitFor(() => expect(cancels(backend)).toBe(2), { timeout: EXIT_BOUND_MS });
    await untilFrame(app, HINT);
    expect(outcomes).toEqual([]);
    app.stdin.write(KEYS.ctrlC);
    await exitedOnce(outcomes);
    expect(cancels(backend)).toBe(2);
    app.unmount();
  });

  it('another key between the two presses disarms the exit', async () => {
    const { app, backend, outcomes } = await workingRun();
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.left);
    await untilFrame(app, (shown) => !shown.includes(HINT));
    app.stdin.write(KEYS.ctrlC);
    await vi.waitFor(() => expect(cancels(backend)).toBe(2), { timeout: EXIT_BOUND_MS });
    await untilFrame(app, HINT);
    expect(outcomes).toEqual([]);
    app.unmount();
  });

  it('exits at two presses within the window when the cancel of the run never completes', async () => {
    const { app, backend, outcomes } = await workingRun();
    backend.cancel = async (runId) => {
      backend.calls.push(`cancel:${runId}`);
      return new Promise<never>(() => undefined);
    };
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.ctrlC);
    await exitedOnce(outcomes);
    expect(cancels(backend)).toBe(1);
    app.unmount();
  });
});

describe('ctrl+c while a background task is working is never swallowed', () => {
  const stubbornTask = () => {
    const seen: { signal?: AbortSignal } = {};
    const command: SlashCommand = {
      name: 'stubborn',
      description: 'a client-side task that never settles',
      run: async (_args, context) => {
        const background = (context as SlashContext & { background: Background }).background;
        void background('stubborn check', (signal) => {
          seen.signal = signal;
          return new Promise<never>(() => undefined);
        }).catch(() => undefined);
      },
    };
    return { command, seen };
  };

  it('aborts the task at the first press and exits at the second within the window although the task never settles', async () => {
    const clock = manualClock();
    const { command, seen } = stubbornTask();
    const { app, outcomes } = await start({}, { now: clock.now, timers: clock.timers, tasks: createBackgroundTasks(), slash: createSlashRegistry([...BUILTIN_SLASH_COMMANDS, command]) } as never);
    await untilFrame(app, 'mode: manual');
    await type(app, '/stubborn', '> /stubborn');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, /running stubborn check \d+s · esc to cancel/);
    app.stdin.write(KEYS.ctrlC);
    await vi.waitFor(() => expect(seen.signal?.aborted).toBe(true), { timeout: EXIT_BOUND_MS });
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.ctrlC);
    await exitedOnce(outcomes);
    app.unmount();
  });

  it('a task already aborted that never settles does not swallow later presses: two presses exit', async () => {
    const clock = manualClock();
    const { command, seen } = stubbornTask();
    const { app, outcomes } = await start({}, { now: clock.now, timers: clock.timers, tasks: createBackgroundTasks(), slash: createSlashRegistry([...BUILTIN_SLASH_COMMANDS, command]) } as never);
    await untilFrame(app, 'mode: manual');
    await type(app, '/stubborn', '> /stubborn');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, /running stubborn check \d+s · esc to cancel/);
    app.stdin.write(KEYS.escape);
    await vi.waitFor(() => expect(seen.signal?.aborted).toBe(true), { timeout: EXIT_BOUND_MS });
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.ctrlC);
    await exitedOnce(outcomes);
    app.unmount();
  });
});
