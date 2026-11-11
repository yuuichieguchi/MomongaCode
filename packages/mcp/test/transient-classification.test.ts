import { describe, expect, it } from 'vitest';
import { OutboundConnectionError } from '@momonga/foundation';
import { isTransientRemoteFailure } from '@momonga/mcp';

const HEADERS_TIMEOUT = 'UND_ERR_HEADERS_TIMEOUT';

const dispatcherError = (code: string): Error => Object.assign(new Error('Headers Timeout Error'), { code });

describe('an error the connect-reply bound of the product produced is transient', () => {
  it('a fetch that failed with UND_ERR_HEADERS_TIMEOUT is classified transient', () => {
    expect(isTransientRemoteFailure(new TypeError('fetch failed', { cause: dispatcherError(HEADERS_TIMEOUT) }))).toBe(true);
  });

  it('an origin connection that ended with UND_ERR_HEADERS_TIMEOUT is classified transient', () => {
    const failure = new OutboundConnectionError({ kind: 'origin-connection', origin: 'https://mcp.example.test', code: HEADERS_TIMEOUT }, { cause: dispatcherError(HEADERS_TIMEOUT) });

    expect(isTransientRemoteFailure(failure)).toBe(true);
  });

  it('a dispatcher code that no bound of the product produces stays not transient', () => {
    expect(isTransientRemoteFailure(new TypeError('fetch failed', { cause: dispatcherError('UND_ERR_INVALID_ARG') }))).toBe(false);
  });
});
