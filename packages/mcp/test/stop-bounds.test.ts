import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStdioTransport } from '@momonga/mcp';
import { SHUTDOWN_SETTING_LIMITS, groupTerminationBoundMs, systemTiming, nodeFileSystem } from '@momonga/foundation';
import type { TerminateOutcome, Timing } from '@momonga/foundation';
import { MCP_RAW_STDIO_SERVER_PATH, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, killGroupsForCleanup, waitFor, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { closeGraceOf } from '../src/stdio-transport.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const dirs: string[] = [];
const groups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(groups.splice(0));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the stop of an MCP stdio server has the one bound of a process group stop', () => {
  it('the transport bounds its stop by groupTerminationBoundMs of its grace', async () => {
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-stop-bound-')));
    dirs.push(projectDir);
    const graceMs = 200;
    const delays: number[] = [];
    const timing: Timing = {
      ...systemTiming,
      setTimeout: (callback, ms) => {
        delays.push(ms);
        return systemTiming.setTimeout(callback, ms);
      },
    };
    let armedAtStop: number[] = [];
    const transport = createStdioTransport({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
      name: 'raw',
      config: { command: process.execPath, args: [MCP_RAW_STDIO_SERVER_PATH] },
      projectDir,
      baseEnv: { PATH: '/usr/bin:/bin' },
      closeGraceMs: graceMs,
      timing,
      terminate: async (): Promise<TerminateOutcome> => {
        armedAtStop = [...delays];
        return 'gone';
      },
    });
    await transport.start();
    if (transport.pgid !== undefined) groups.push(transport.pgid);
    await transport.close();

    expect(armedAtStop).toContain(groupTerminationBoundMs(graceMs));
  });
});

describe('the MCP close grace has one default and no floor', () => {
  it('the default grace of the transport is the default of the mcpCloseGraceMs setting', () => {
    expect(closeGraceOf(undefined)).toBe(SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.default);
  });

  it('at grace 0 the end of a remote session gets 0 ms: no timer is armed for it and the close says 0 ms', async () => {
    const fixture = await startHttpFixture({ era: 'legacy', holdSessionDelete: true });
    const fake = createFakeTimers(createFakeClock(1_000_000));
    const delays: number[] = [];
    const timers = {
      ...fake,
      setTimeout: (callback: () => void, ms: number) => {
        delays.push(ms);
        return fake.setTimeout(callback, ms);
      },
    };
    const { connection } = makeRemoteConnection({ fixture, timers, closeInCleanup: false });
    await connection.listTools();
    delays.length = 0;
    let outcome: { error: unknown } | undefined;
    connection.close(0).then(
      () => (outcome = { error: undefined }),
      (error: unknown) => (outcome = { error }),
    );
    await waitFor(() => outcome !== undefined || delays.length > 0, { description: 'the close at grace 0 to end or to arm a timer' });

    expect(delays).toEqual([]);
    expect((outcome?.error as Error | undefined)?.message).toContain('did not end its session within 0ms');
  });
});
