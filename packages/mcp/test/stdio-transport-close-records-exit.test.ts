import { nodeFileSystem } from '@momonga/foundation';
import { createStdioTransport } from '@momonga/mcp';
import { killGroupsForCleanup, REAL_PROCESS_TEST_TIMEOUT_MS, systemTempRoot, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const groups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(groups.splice(0));
});

const sleeper = async (terminate: NonNullable<Parameters<typeof createStdioTransport>[0]['terminate']>) => {
  const closes: Array<{ exitAtClose: unknown }> = [];
  const transport = createStdioTransport({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
    name: 'sleeper',
    config: { command: '/bin/sleep', args: ['300'] },
    projectDir: systemTempRoot(),
    baseEnv: { PATH: '/usr/bin:/bin' },
    closeGraceMs: 0,
    terminate,
  });
  transport.onclose = () => closes.push({ exitAtClose: transport.diagnostics().exit });
  await transport.start();
  if (transport.pgid !== undefined) groups.push(transport.pgid);
  return { transport, closes };
};

describe('the stdio close records the exit of its child before it returns (host-bounds follow-ups, item 5)', () => {
  it.for(['killed', 'terminated', 'gone'] as const)('with the group confirmed %s, close resolves with the exit recorded, at a grace of 0', async (outcome) => {
    const { transport, closes } = await sleeper(async (pgid) => {
      process.kill(-pgid, 'SIGKILL');
      return outcome;
    });
    await transport.close();
    expect(transport.diagnostics().exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(closes).toEqual([{ exitAtClose: { code: null, signal: 'SIGKILL' } }]);
  });

  it('with the group unconfirmed, close resolves without the exit of a child that never ends', async () => {
    const { transport, closes } = await sleeper(async () => 'unconfirmed');
    await transport.close();
    expect(transport.diagnostics().exit).toBeNull();
    expect(closes).toHaveLength(1);
  });
});
