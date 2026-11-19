import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { App } from '../src/tui/app.tsx';
import { STARTING_TEXT } from '../src/tui/screen/waiting-row.tsx';
import type { AppProps, TuiOutcome } from '../src/tui/app.tsx';
import { fakeBackend } from './fake-backend.ts';
import type { FakeBackend, FakeBackendOptions } from './fake-backend.ts';
import { KEYS, TEST_KEY_SETTLE_MS, renderObservable, untilFrame, untilOutput, settleAtOnce } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { WIDE_TEST_SCREEN, fakeScreenTerminal } from './tui/screen-fakes.ts';
import type { FakeScreenSize } from './tui/screen-fakes.ts';
import { systemTiming } from '@momonga/foundation';

export const base = { runId: 'run-1', sessionId: 'session-1', step: 1, createdAt: 1 } as const;

let sequence = 0;

export const frame = (event: Record<string, unknown>): RunEventFrame => {
  sequence += 1;
  return { id: sequence, event: String(event['type']), data: { ...base, id: sequence, seq: sequence, ...event } as PublicRunEvent };
};

export const startStillStarting = async (options: FakeBackendOptions = {}, extra: Partial<Pick<AppProps, 'initialPrompt' | 'initialImages' | 'initialSkill' | 'startup' | 'colour' | 'copyOnSelect' | 'now' | 'timers' | 'keySettleMs' | 'reopen' | 'tuiSettings' | 'tasks' | 'move' | 'adoption' | 'keyBindings'>> = {}, screen: Partial<FakeScreenSize> = {}) => {
  const backend = fakeBackend(options);
  const terminal = fakeScreenTerminal({ ...WIDE_TEST_SCREEN, ...screen });
  const outcomes: TuiOutcome[] = [];
  const exited = Promise.withResolvers<TuiOutcome>();
  const keySettleMs = extra.keySettleMs ?? TEST_KEY_SETTLE_MS;
  const given = extra.timers ?? systemTiming;
  const app = renderObservable(
    <App
      backend={backend}
      terminal={terminal}
      initialMode={undefined}
      now={Date.now}
      {...extra}
      keySettleMs={keySettleMs}
      timers={keySettleMs === TEST_KEY_SETTLE_MS ? settleAtOnce(given) : given}
      onExit={(outcome) => {
        outcomes.push(outcome);
        exited.resolve(outcome);
      }}
    />,
  );
  return { backend, app, terminal, outcomes, exited: exited.promise };
};

type StartArguments = Parameters<typeof startStillStarting>;

export const start = async (...given: StartArguments): ReturnType<typeof startStillStarting> => {
  const started = await startStillStarting(...given);
  await Promise.race([untilFrame(started.app, (now) => now !== '' && !now.includes(STARTING_TEXT)), started.exited]);
  return started;
};

export const type = async (app: Instance, text: string, echo: string): Promise<void> => {
  app.stdin.write(text);
  await untilFrame(app, echo);
};

export const runStarted = async (backend: FakeBackend, app: Instance, text: string): Promise<void> => {
  await type(app, text, `> ${text}`);
  app.stdin.write(KEYS.enter);
  await untilOutput(app, `> ${text}`);
  await backend.called('openSession');
};

