import { describe, expect, it } from 'vitest';
import { startSharedCall } from '../src/shared-call.ts';

type Held<T> = { promise: Promise<T>; resolve(value: T): void; signals: AbortSignal[] };

const heldWork = <T>(): Held<T> & { run(signal: AbortSignal): Promise<T> } => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => (resolve = settle));
  const signals: AbortSignal[] = [];
  return {
    promise,
    resolve: (value) => resolve(value),
    signals,
    run: (signal) => {
      signals.push(signal);
      return promise;
    },
  };
};

const outcomeOf = (promise: Promise<unknown>): Promise<{ value: unknown } | { error: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

const aborted = (reason: Error): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

describe('shared work lives as long as its owner, never as long as an asker', () => {
  it('refuses a join whose signal is already aborted before it counts it, so a live join after it gets the value', async () => {
    const work = heldWork<string>();
    const call = startSharedCall(new AbortController().signal, work.run);
    const reason = new Error('already gone');

    expect(await outcomeOf(call.join(aborted(reason)))).toEqual({ error: reason });
    expect(work.signals[0]?.aborted).toBe(false);
    const live = outcomeOf(call.join(new AbortController().signal));
    work.resolve('value');
    expect(await live).toEqual({ value: 'value' });
  });

  it('runs to completion after its only waiter left, and a later join within the lifetime gets the value', async () => {
    const work = heldWork<string>();
    const call = startSharedCall(new AbortController().signal, work.run);
    const asker = new AbortController();
    const left = new Error('the asker left');

    const first = outcomeOf(call.join(asker.signal));
    asker.abort(left);
    expect(await first).toEqual({ error: left });
    expect(work.signals[0]?.aborted).toBe(false);
    work.resolve('value');
    expect(await call.join(new AbortController().signal)).toBe('value');
  });

  it('ends the work with its lifetime', async () => {
    const work = heldWork<string>();
    const lifetime = new AbortController();
    startSharedCall(lifetime.signal, work.run);
    const ended = new Error('the owner closed');
    lifetime.abort(ended);
    expect(work.signals[0]?.aborted).toBe(true);
    expect(work.signals[0]?.reason).toBe(ended);
  });
});
