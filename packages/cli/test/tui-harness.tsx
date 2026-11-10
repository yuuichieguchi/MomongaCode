import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { App } from '../src/tui/app.tsx';
import type { AppProps, TuiOutcome } from '../src/tui/app.tsx';
import { fakeBackend } from './fake-backend.ts';
import type { FakeBackend, FakeBackendOptions } from './fake-backend.ts';
import { KEYS, renderObservable, untilFrame, untilOutput } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { fakeScreenTerminal } from './tui/screen-fakes.ts';
import { systemTiming } from '@momonga/foundation';

export const base = { runId: 'run-1', sessionId: 'session-1', step: 1, createdAt: 1 } as const;

let sequence = 0;

export const frame = (event: Record<string, unknown>): RunEventFrame => {
  sequence += 1;
  return { id: sequence, event: String(event['type']), data: { ...base, id: sequence, seq: sequence, ...event } as PublicRunEvent };
};

export const start = async (options: FakeBackendOptions = {}, extra: Partial<Pick<AppProps, 'initialPrompt' | 'initialImages' | 'startup' | 'copyOnSelect' | 'now' | 'timers' | 'reopen' | 'tuiSettings'>> = {}, screen: Parameters<typeof fakeScreenTerminal>[0] = {}) => {
  const backend = fakeBackend(options);
  const terminal = fakeScreenTerminal(screen);
  const outcomes: TuiOutcome[] = [];
  const exited = Promise.withResolvers<TuiOutcome>();
  const app = renderObservable(
    <App
      backend={backend}
      terminal={terminal}
      initialMode={undefined}
      now={Date.now}
      timers={systemTiming}
      {...extra}
      onExit={(outcome) => {
        outcomes.push(outcome);
        exited.resolve(outcome);
      }}
    />,
  );
  return { backend, app, terminal, outcomes, exited: exited.promise };
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

