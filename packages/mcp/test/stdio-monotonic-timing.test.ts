import { describe, expect, it, vi } from 'vitest';
import { createManagedConnection } from '@momonga/mcp';
import { nodeFileSystem } from '@momonga/foundation';
import { createFakeClock, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { BASE_ENV, makeDir, onCleanup } from './mcp-harness.ts';

const NEVER_ANSWERS = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

describe('the stdio transport reads its monotonic time from the timing port', () => {
  it('takes the monotonic reading of the close bound from timing.monotonicMs, not from the wall clock', async () => {
    const clock = createFakeClock(1_000_000);
    const monotonicMs = vi.fn(() => 7);
    const connection = createManagedConnection({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
      clientVersion: '0.0.0-test',
      name: 'never',
      config: NEVER_ANSWERS,
      scope: 'user',
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock,
      timing: { monotonicMs },
      random: () => 0,
      connectTimeoutMs: 60_000,
    });
    onCleanup(() => connection.close());
    const attempt = connection.connect().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await connection.close(0);
    await attempt;
    expect(monotonicMs).toHaveBeenCalled();
  });
});
