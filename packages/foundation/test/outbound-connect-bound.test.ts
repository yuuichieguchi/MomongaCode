import type { LookupFunction } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOutboundDispatcher } from '@momonga/foundation';
import type { OutboundNetwork } from '@momonga/foundation';

const CONNECT_BOUND_MS = 200;
const UNDICI_DEFAULT_CONNECT_MS = 10_000;
const TEST_TIMEOUT_MS = UNDICI_DEFAULT_CONNECT_MS / 2;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const DIRECT: OutboundNetwork = { config: { caFiles: [] }, trust: { sources: [], failures: [] } };

const neverAnswered: LookupFunction = () => undefined;

describe('a direct dial of the outbound client', () => {
  it(
    'gives up at the connect bound of the operation, not at the default of the HTTP library',
    async () => {
      const dispatcher = createOutboundDispatcher(DIRECT, { connectReplyTimeoutMs: CONNECT_BOUND_MS, lookup: neverAnswered });
      closers.push(() => dispatcher.destroy());
      await expect(dispatcher.request({ origin: 'http://unanswered.test', path: '/', method: 'GET' })).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});
