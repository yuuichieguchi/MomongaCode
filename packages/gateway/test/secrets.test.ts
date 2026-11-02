import { describe, expect, it } from 'vitest';
import { SecretUnavailableError } from '@momonga/foundation';
import type { SecretStore } from '@momonga/foundation';
import { createSecretResolver } from '../src/secrets.ts';

type Pending = { name: string; signal: AbortSignal; resolve(value: string): void; reject(error: unknown): void };

const controlledStore = (): { store: SecretStore; reads: Pending[] } => {
  const reads: Pending[] = [];
  const store: SecretStore = {
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
