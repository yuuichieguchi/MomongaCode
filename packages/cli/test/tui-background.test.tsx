import { describe, expect, it } from 'vitest';
import { App } from '../src/tui/app.tsx';
import { createBackgroundTasks } from '../src/tui/background-tasks.ts';
import { BUILTIN_SLASH_COMMANDS, createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashCommand, SlashContext } from '../src/tui/slash.ts';
import { fakeBackend } from './fake-backend.ts';
import { KEYS, renderObservable, untilFrame } from './ink-helpers.ts';
import { runStarted, type } from './tui-harness.tsx';

type Background = <T>(label: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

const longCheck = () => {
  const seen: { signal?: AbortSignal; cleaned: boolean } = { cleaned: false };
  const command: SlashCommand = {
    name: 'long',
    description: 'a long client-side task',
    run: (_args, context) => {
      const background = (context as SlashContext & { background: Background }).background;
      void background('long check', async (signal) => {
        seen.signal = signal;
        try {
          await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        } finally {
          await Promise.resolve();
          seen.cleaned = true;
        }
      }).catch(() => undefined);
    },
  };
  return { command, seen };
};

const startWith = async (command: SlashCommand, tasks = createBackgroundTasks()) => {
  const backend = fakeBackend();
  const app = renderObservable(<App backend={backend} initialMode={undefined} slash={createSlashRegistry([...BUILTIN_SLASH_COMMANDS, command])} {...({ tasks } as object)} onExit={() => undefined} />);
  await untilFrame(app, 'mode: default');
  return { backend, app, tasks };
};

const startCheck = async (app: ReturnType<typeof renderObservable>, seen: { signal?: AbortSignal }) => {
  await type(app, '/long', '> /long');
  app.stdin.write(KEYS.enter);
  await untilFrame(app, 'esc cancels');
  expect(seen.signal?.aborted).toBe(false);
};

const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe('a long client-side task in the TUI (C1)', () => {
  it('does not block input: a prompt can be sent while the check runs', async () => {
    const { command, seen } = longCheck();
    const { backend, app } = await startWith(command);
    await startCheck(app, seen);
    await runStarted(backend, app, 'other work');
    expect(backend.started.map((entry) => entry.text)).toEqual(['other work']);
    expect(seen.signal?.aborted).toBe(false);
    app.unmount();
  });

  it('cancels the check on escape when no prompt run is pending', async () => {
    const { command, seen } = longCheck();
    const { app } = await startWith(command);
    await startCheck(app, seen);
    app.stdin.write(KEYS.escape);
    await until(() => seen.signal?.aborted === true);
    app.unmount();
  });

  it('cancels a pending prompt run first and the check with a second escape', async () => {
    const { command, seen } = longCheck();
    const { backend, app } = await startWith(command);
    await startCheck(app, seen);
    await runStarted(backend, app, 'long task');
    await untilFrame(app, 'working (esc to cancel)');
    app.stdin.write(KEYS.escape);
    await backend.called('cancel:run-1');
    expect(seen.signal?.aborted).toBe(false);
    backend.finish({ ...(await import('./fake-backend.ts')).runView({ status: 'CANCELLED' }) });
    await untilFrame(app, 'esc cancels');
    app.stdin.write(KEYS.escape);
    await until(() => seen.signal?.aborted === true);
    app.unmount();
  });
});

describe('leaving the TUI during a check (C2)', () => {
  it('aborts every registered task and settles only after each has cleaned up', async () => {
    const { command, seen } = longCheck();
    const { app, tasks } = await startWith(command);
    await startCheck(app, seen);
    await type(app, '/exit', '> /exit');
    app.stdin.write(KEYS.enter);
    await tasks.settle();
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.cleaned).toBe(true);
    app.unmount();
  });

  it('settles at once with no task registered', async () => {
    await expect(createBackgroundTasks().settle()).resolves.toBeUndefined();
  });
});
