import { describe, expect, it, vi } from 'vitest';
import { createStdioTransport } from '@momonga/mcp';
import { nodeFileSystem, systemTiming } from '@momonga/foundation';
import { TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { BASE_ENV, makeDir, onCleanup } from './mcp-harness.ts';

const NEVER_ANSWERS = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

describe('the stdio transport reads its monotonic time from the timing port', () => {
  it('takes the monotonic reading of the close bound from timing.monotonicMs, not from the wall clock', async () => {
    const monotonicMs = vi.fn(() => 7);
    const transport = createStdioTransport({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
      name: 'never',
      config: NEVER_ANSWERS,
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      timing: { ...systemTiming, monotonicMs },
    });
    onCleanup(() => transport.close(0));
    await transport.start();
    await transport.close(0);
    expect(monotonicMs).toHaveBeenCalled();
  });
});
