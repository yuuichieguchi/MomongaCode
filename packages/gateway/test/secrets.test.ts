import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationLimitError, SecretUnavailableError, StoreCallEndedError, operationLimit } from '@momonga/foundation';
import { KEYCHAIN_BACKEND } from '@momonga/foundation/secret-store';
import type { SecretStore } from '@momonga/foundation';
import { createSecretResolver } from '../src/secrets.ts';

type Pending = { name: string; signal: AbortSignal; resolve(value: string): void; reject(error: unknown): void };

const controlledStore = (): { store: Pick<SecretStore, 'read'>; reads: Pending[] } => {
  const reads: Pending[] = [];
  const store: Pick<SecretStore, 'read'> = {
    read: (name, signal) =>
      new Promise<string>((resolve, reject) => {
        reads.push({ name, signal, resolve, reject });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  };
  return { store, reads };
};

const NEVER_ABORTED = new AbortController().signal;
const absent = (name: string): SecretUnavailableError => new SecretUnavailableError(name, 44, '');

describe('secret resolver', () => {
  it('serves a resolved secret from memory without reading again', async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store);
    const first = resolver.read('k', NEVER_ABORTED);
    reads[0]?.resolve('value-0001');
    expect(await first).toBe('value-0001');
    expect(await resolver.read('k', NEVER_ABORTED)).toBe('value-0001');
    expect(reads).toHaveLength(1);
    expect([...resolver.resolved()]).toEqual([['k', 'value-0001']]);
  });

  it('reads a failed secret again on the next call', async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store);
    const first = resolver.read('k', NEVER_ABORTED);
    reads[0]?.reject(absent('k'));
    await expect(first).rejects.toBeInstanceOf(SecretUnavailableError);
    const second = resolver.read('k', NEVER_ABORTED);
    reads[1]?.resolve('value-0002');
    expect(await second).toBe('value-0002');
    expect(reads).toHaveLength(2);
  });

  it('shares one read between concurrent callers', async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store);
    const callers = [resolver.read('k', NEVER_ABORTED), resolver.read('k', NEVER_ABORTED)];
    expect(reads).toHaveLength(1);
    reads[0]?.resolve('value-0003');
    expect(await Promise.all(callers)).toEqual(['value-0003', 'value-0003']);
  });

  it('keeps the shared read alive while any caller still waits and aborts it when the last caller leaves', async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store);
    const first = new AbortController();
    const second = new AbortController();
    const leaving = resolver.read('k', first.signal);
    const staying = resolver.read('k', second.signal);
    first.abort(new Error('first left'));
    await expect(leaving).rejects.toThrow('first left');
    expect(reads[0]?.signal.aborted).toBe(false);
    second.abort(new Error('second left'));
    await expect(staying).rejects.toThrow('second left');
    expect(reads[0]?.signal.aborted).toBe(true);
  });

  it('starts a fresh read for a caller that arrives after the last waiter aborted the shared read', async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store);
    const leaver = new AbortController();
    const leaving = resolver.read('k', leaver.signal);
    leaver.abort(new Error('left'));
    await expect(leaving).rejects.toThrow('left');
    const next = resolver.read('k', NEVER_ABORTED);
    expect(reads).toHaveLength(2);
    reads[1]?.resolve('value-0004');
    expect(await next).toBe('value-0004');
  });

  it('rejects at once for a signal that is already aborted without reading', async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store);
    await expect(resolver.read('k', AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
    expect(reads).toEqual([]);
  });

  it('tells listeners about a value before the read resolves to its caller', async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store);
    const heard: string[] = [];
    resolver.onResolved((name, value) => heard.push(`${name}=${value}`));
    const pending = resolver.read('k', NEVER_ABORTED);
    reads[0]?.resolve('value-0005');
    const value = await pending;
    expect(heard).toEqual(['k=value-0005']);
    expect(value).toBe('value-0005');
  });
});

describe('secret resolver waiters under the limit of their request', () => {
  const REQUEST_LIMIT_MS = 300_000;
  const LIMIT_SENTENCE =
    'the read of the secret "k" did not finish within the request limit of 300000 ms; the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain';

  const settled = <T>(pending: Promise<T>): { state(): 'pending' | 'fulfilled' | 'rejected'; error(): unknown } => {
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    let error: unknown;
    pending.then(
      () => {
        state = 'fulfilled';
      },
      (failure: unknown) => {
        state = 'rejected';
        error = failure;
      },
    );
    return { state: () => state, error: () => error };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a waiter that leaves on a limit gets a StoreCallEndedError', async () => {
    vi.useFakeTimers();
    const { store } = controlledStore();
    const resolver = createSecretResolver(store, KEYCHAIN_BACKEND);
    const limit = operationLimit(NEVER_ABORTED, REQUEST_LIMIT_MS, 'the request limit');

    const waiting = settled(resolver.read('k', limit.signal));
    await vi.advanceTimersByTimeAsync(REQUEST_LIMIT_MS - 1);
    expect(waiting.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);

    expect(waiting.state()).toBe('rejected');
    const failure = waiting.error() as StoreCallEndedError;
    expect(failure).toBeInstanceOf(StoreCallEndedError);
    expect(failure.message).toBe(LIMIT_SENTENCE);
    expect(failure.call).toEqual({ action: 'read', name: 'k', backend: KEYCHAIN_BACKEND });
    expect(failure.limit).toBe(limit.signal.reason);
    limit.dispose();
  });

  it('a shared read ends only when its last waiter has left', async () => {
    vi.useFakeTimers();
    const SECOND_ARRIVES_AFTER_MS = 100_000;
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store, KEYCHAIN_BACKEND);

    const firstLimit = operationLimit(NEVER_ABORTED, REQUEST_LIMIT_MS, 'the request limit');
    const first = settled(resolver.read('k', firstLimit.signal));
    await vi.advanceTimersByTimeAsync(SECOND_ARRIVES_AFTER_MS);
    const secondLimit = operationLimit(NEVER_ABORTED, REQUEST_LIMIT_MS, 'the request limit');
    const second = settled(resolver.read('k', secondLimit.signal));
    expect(reads).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(REQUEST_LIMIT_MS - SECOND_ARRIVES_AFTER_MS);
    expect(first.state()).toBe('rejected');
    expect(first.error()).toBeInstanceOf(StoreCallEndedError);
    expect((first.error() as Error).message).toBe(LIMIT_SENTENCE);
    expect(second.state()).toBe('pending');
    expect(reads[0]?.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(SECOND_ARRIVES_AFTER_MS);
    expect(second.state()).toBe('rejected');
    expect(second.error()).toBeInstanceOf(StoreCallEndedError);
    expect((second.error() as StoreCallEndedError).limit).toBe(secondLimit.signal.reason);
    expect(reads[0]?.signal.aborted).toBe(true);
    expect(reads[0]?.signal.reason).toBeInstanceOf(OperationLimitError);
    expect(reads[0]?.signal.reason).toBe(secondLimit.signal.reason);
    expect([...resolver.resolved()]).toEqual([]);

    const third = resolver.read('k', NEVER_ABORTED);
    expect(reads).toHaveLength(2);
    reads[1]?.resolve('value-0006');
    expect(await third).toBe('value-0006');
    firstLimit.dispose();
    secondLimit.dispose();
  });

  it("a read aborted by every waiter aborts the resolver's controller", async () => {
    const { store, reads } = controlledStore();
    const resolver = createSecretResolver(store, KEYCHAIN_BACKEND);
    const first = new AbortController();
    const second = new AbortController();
    const firstReason = new Error('first left');
    const secondReason = new Error('second left');
    const leaving = resolver.read('k', first.signal);
    const staying = resolver.read('k', second.signal);

    first.abort(firstReason);
    await expect(leaving).rejects.toBe(firstReason);
    expect(reads[0]?.signal.aborted).toBe(false);
    second.abort(secondReason);
    await expect(staying).rejects.toBe(secondReason);

    expect(reads[0]?.signal.aborted).toBe(true);
    expect(reads[0]?.signal.reason).toBe(secondReason);
  });

  it('a client disconnect reaches the caller as the reason itself', async () => {
    const { store } = controlledStore();
    const resolver = createSecretResolver(store, KEYCHAIN_BACKEND);
    const request = new AbortController();
    const disconnected = new Error('the client disconnected');

    const waiting = resolver.read('k', request.signal);
    request.abort(disconnected);

    await expect(waiting).rejects.toBe(disconnected);
  });
});
