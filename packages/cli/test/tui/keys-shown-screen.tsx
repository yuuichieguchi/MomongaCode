import { pollUntil } from '@momonga/testkit';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import { startPlan } from '../fake-plan-gateway.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { FRAME_BOUND_MS, KEYS } from '../ink-helpers.ts';
import { manualClock } from './screen-clock.ts';

const STEP_MS = 5;

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type Held = { release(): void; calls(): number };

export const startAtRealTiming = async (options: FakePlanOptions) => {
  const clock = manualClock(1_000_000);
  const started = await startPlan({ ...options, answerTimers: clock.timers }, {}, {}, { now: clock.now, timers: clock.timers, keySettleMs: KEY_SETTLE_MS });
  const pause = async (ms: number): Promise<void> => {
    for (let passed = 0; passed < ms; passed += STEP_MS) {
      clock.advance(Math.min(STEP_MS, ms - passed));
      await yieldTurn();
    }
  };
  const frameNow = (): string => started.app.lastFrame() ?? '';
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
  const untilShown = (holds: string | ((frame: string) => boolean)): Promise<string> => until(typeof holds === 'string' ? (frame) => frame.includes(holds) : holds, String(holds));
  const settled = (): Promise<void> => pause(KEY_SETTLE_MS * 2);
  const submit = async (line: string): Promise<void> => {
    started.app.stdin.write(line);
    await untilShown(`> ${line}`);
    started.app.stdin.write(KEYS.enter);
  };
  const burst = async (keys: readonly (readonly [string, number])[]): Promise<void> => {
    for (const [key, gap] of keys) {
      if (gap > 0) await pause(gap);
      started.app.stdin.write(key);
    }
  };
  const mark = (): (() => readonly string[]) => {
    const from = started.app.frames.length;
    return () => started.app.frames.slice(from);
  };
  await untilShown('mode: manual');
  await settled();
  return { ...started, clock, pause, until, untilShown, settled, submit, burst, mark, frameNow };
};

export type AtRealTiming = Awaited<ReturnType<typeof startAtRealTiming>>;

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

export const PROBE = 'zq7';
