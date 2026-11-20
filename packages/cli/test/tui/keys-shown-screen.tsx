import { pollUntil } from '@momonga/testkit';
import { App } from '../../src/tui/app.tsx';
import type { AppProps, TuiOutcome } from '../../src/tui/app.tsx';
import type { TuiBackend } from '../../src/tui/backend.ts';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import { fakePlanBackend } from '../fake-plan-gateway.tsx';
import type { FakePlanBackend, FakePlanOptions } from '../fake-plan-gateway.tsx';
import { FRAME_BOUND_MS, KEYS, renderObservable } from '../ink-helpers.ts';
import { WIDE_TEST_SCREEN, fakeScreenTerminal, throughTheLayer } from './screen-fakes.ts';
import type { FakeScreenSize } from './screen-fakes.ts';
import { manualClock } from './screen-clock.ts';

const STEP_MS = 5;
const KITTY_ESCAPE = '\u001b[27u';

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type Held = { release(): void; calls(): number };

export type Shown = string | ((frame: string) => boolean);

const flat = (text: string): string => text.replace(/[│\s]+/g, ' ');

export const shows = (shown: Shown) => (frame: string): boolean => (typeof shown === 'string' ? frame.includes(shown) || flat(frame).includes(flat(shown)) : shown(frame));

export type StartGiven = {
  readonly options?: FakePlanOptions;
  readonly extra?: Partial<AppProps>;
  readonly screen?: Partial<FakeScreenSize>;
  readonly ready?: Shown;
  readonly prepare?: (backend: FakePlanBackend) => void;
  readonly early?: string;
};

export const startAtRealTiming = async (given: FakePlanOptions | StartGiven = {}) => {
  const { options = {}, extra = {}, screen = {}, ready = 'mode: manual', prepare, early } = 'options' in given || 'extra' in given || 'ready' in given || 'prepare' in given || 'screen' in given || 'early' in given ? (given as StartGiven) : { options: given as FakePlanOptions };
  const clock = manualClock(1_000_000);
  const backend = fakePlanBackend({ ...options, answerTimers: clock.timers });
  prepare?.(backend);
  const outcomes: TuiOutcome[] = [];
  const terminal = fakeScreenTerminal({ ...WIDE_TEST_SCREEN, ...screen });
  const app = renderObservable(<App backend={backend as TuiBackend} terminal={terminal} now={clock.now} timers={clock.timers} initialMode={undefined} {...extra} onExit={(outcome) => void outcomes.push(outcome)} />);
  const written = throughTheLayer(terminal, clock.timers);
  app.stdin.write = (text: string): void => written(text === KEYS.escape ? KITTY_ESCAPE : text);
  const oneWrite = (bytes: string): void => written(bytes);
  const oneBatch = (keys: string): void => {
    written(`${keys}${KITTY_ESCAPE}`);
  };
  const pause = async (ms: number): Promise<void> => {
    for (let passed = 0; passed < ms; passed += STEP_MS) {
      clock.advance(Math.min(STEP_MS, ms - passed));
      await yieldTurn();
    }
  };
  const frameNow = (): string => app.lastFrame() ?? '';
  const until = async (holds: (frame: string) => boolean, description: string): Promise<string> => {
    await pollUntil(
      async () => {
        await pause(STEP_MS);
        return holds(frameNow());
      },
      { description, boundMs: FRAME_BOUND_MS },
    );
    return frameNow();
  };
  const untilShown = (shown: Shown): Promise<string> => until(shows(shown), String(shown));
  const settled = (): Promise<void> => pause(KEY_SETTLE_MS * 2);
  const submit = async (line: string): Promise<void> => {
    app.stdin.write(line);
    await untilShown(`> ${line}`);
    app.stdin.write(KEYS.enter);
  };
  const step = async (keys: string, shown: Shown): Promise<string> => {
    app.stdin.write(keys);
    const frame = await untilShown(shown);
    await settled();
    return frame;
  };
  const burst = async (keys: readonly (readonly [string, number])[]): Promise<void> => {
    for (const [key, gap] of keys) {
      if (gap > 0) await pause(gap);
      app.stdin.write(key);
    }
  };
  const mark = (): (() => readonly string[]) => {
    const from = app.frames.length;
    return () => app.frames.slice(from);
  };
  if (early !== undefined) {
    app.stdin.write(early);
    await pause(300);
  }
  await untilShown(ready);
  await settled();
  return { app, backend, terminal, outcomes, clock, oneWrite, oneBatch, pause, until, untilShown, settled, submit, step, burst, mark, frameNow };
};

export type AtRealTiming = Awaited<ReturnType<typeof startAtRealTiming>>;

export const NOTHING_HELD: Held = { release: () => undefined, calls: () => 0 };

export const hold = <Target extends object, Name extends keyof Target>(target: Target, name: Name): Held => {
  const original = target[name] as unknown as (...given: unknown[]) => Promise<unknown>;
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const replaced = async (...given: unknown[]): Promise<unknown> => {
    calls += 1;
    await gate.promise;
    return original.apply(target, given);
  };
  Object.assign(target, { [name]: replaced });
  return { release: () => gate.resolve(), calls: () => calls };
};

export const inputLineOf = (frame: string): string =>
  frame
    .split('\n')
    .map((row) => row.replace(/^│ /, '').replace(/\s*│$/, '').trimEnd())
    .findLast((row) => row.startsWith('> ') || row === '>') ?? '';

export const highlighted = (label: string) => (frame: string): boolean => frame.split('\n').some((row) => row.includes('›') && row.includes(label));

export const PROBE = 'zq7';

export const screenHead = (frame: string): string => {
  const rows = frame.split('\n');
  const start = rows.findIndex((row) => row.startsWith('╭'));
  const end = rows.findIndex((row, index) => index > start && row.startsWith('╰'));
  return rows
    .slice(start + 1, end)
    .map((row) => row.replace(/^│ ?/, '').replace(/\s*│?\s*$/, ''))
    .filter((row) => row !== '')
    .slice(0, 2)
    .map((row) => row.replace(/\/private\/tmp\/\S+|\/tmp\/\S+|\/var\/folders\/\S+/g, '<place>').replace(/\s+/g, ' '))
    .join(' / ');
};

export const shownLines = (frame: string): readonly string[] => frame.split('\n').map((row) => row.trimEnd()).filter((row) => row.trim() !== '');
