import { describe, expect, it, vi } from 'vitest';
import { HOST_READ_BOUND_MS, fixedSocket } from '@momonga/foundation';
import { createRuntimeClient } from '../src/client/runtime-client.ts';

const created = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  const createUdsClient: typeof original.createUdsClient = (resolveSocket, options) => {
    created.options.push(options);
    return original.createUdsClient(resolveSocket, options);
  };
  return { ...original, createUdsClient };
});

describe('the limit of a request to the runtime is stated by the product', () => {
  it('gives the client the host read bound as the limit for the headers of an answer', async () => {
    const client = createRuntimeClient({ resolveSocket: fixedSocket('/unused.sock') });
    await client.close();

    expect(created.options).toEqual([{ headersTimeoutMs: HOST_READ_BOUND_MS }]);
    expect(HOST_READ_BOUND_MS).toBe(300_000);
  });
});
