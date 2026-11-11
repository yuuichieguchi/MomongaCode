import { nodeFileSystem } from '@momonga/foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedConnection } from '@momonga/mcp';
import { createFakeClock } from '@momonga/testkit';
import { LIMIT_TEST, limitArmed, outcomeOf, settledAfter, stillPendingAfter, useLimitTimers } from './credential-store-fakes.ts';
import { BASE_ENV, makeDir, onCleanup } from './mcp-harness.ts';

const NEVER_ANSWERS = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

describe('mcp.connectTimeoutMs bounds the connect of a server that never answers (host-bounds follow-ups, item 7a)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const silentServer = (connectTimeoutMs: number) => {
    const connection = createManagedConnection({ files: nodeFileSystem,
      clientVersion: '0.0.0-test',
      name: 's',
      config: NEVER_ANSWERS,
      scope: 'user',
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock: createFakeClock(1_000_000),
      random: () => 0,
      connectTimeoutMs,
    });
    onCleanup(() => connection.close());
    return connection;
  };

  it.for([5000, 120_000])('the connect rejects at the configured %d ms, not at 30 000', LIMIT_TEST, async (connectTimeoutMs) => {
    const connection = silentServer(connectTimeoutMs);
    useLimitTimers();

    const attempt = outcomeOf(connection.connect());
    await limitArmed();
    await stillPendingAfter(attempt, connectTimeoutMs - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(attempt);

    expect(attempt.state()).toBe('rejected');
    expect((attempt.error() as Error).message).toBe(`the connect did not finish within the MCP connect limit of ${connectTimeoutMs} ms`);
    expect(connection.diagnostics().state).toBe('disconnected');
  });

  it('a reconnect is bounded by the same configured value', LIMIT_TEST, async () => {
    const connection = silentServer(5000);
    useLimitTimers();

    for (const _attempt of [1, 2]) {
      const attempt = outcomeOf(connection.connect());
      await limitArmed();
      await stillPendingAfter(attempt, 4999);
      await vi.advanceTimersByTimeAsync(1);
      await settledAfter(attempt);
      expect((attempt.error() as Error).message).toBe('the connect did not finish within the MCP connect limit of 5000 ms');
    }
  });
});
