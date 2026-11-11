import { describe, expect, it, vi } from 'vitest';
import { HOST_READ_BOUND_MS, fixedSocket } from '@momonga/foundation';
import { createRuntimeClient } from '../src/client/runtime-client.ts';
import { nodeClock } from '../src/node-ports.ts';

const FAKE_PERSON_CAPABILITY = 'f'.repeat(32);

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
  it('gives the client the host read bound as the limit of the connection and of the headers of an answer', async () => {
    const client = createRuntimeClient({ personCapability: async () => FAKE_PERSON_CAPABILITY, resolveSocket: fixedSocket('/unused.sock'), clock: nodeClock });
    await client.close();

    expect(created.options).toEqual([{ connectTimeoutMs: HOST_READ_BOUND_MS, headersTimeoutMs: HOST_READ_BOUND_MS }]);
    expect(HOST_READ_BOUND_MS).toBe(300_000);
  });
});
