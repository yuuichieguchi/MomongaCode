import { nodeFileSystem } from '@momonga/foundation';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStdioTransport } from '@momonga/mcp';
import type { TerminateOutcome } from '@momonga/foundation';
import { MCP_RAW_STDIO_SERVER_PATH, REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const dirs: string[] = [];
const groups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(groups.splice(0));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mcp close bounds terminateGroup by its close signal (G.1 call-site table: "mcp/src/stdio-transport.ts:221 terminateGroup: already awaited; passes the close signal")', () => {
  it('close passes an AbortSignal to terminateGroup', async () => {
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-close-')));
    dirs.push(projectDir);
    const seen: Array<{ graceMs: number; signal?: AbortSignal }> = [];
    const transport = createStdioTransport({ files: nodeFileSystem,
      name: 'raw',
      config: { command: process.execPath, args: [MCP_RAW_STDIO_SERVER_PATH] },
      projectDir,
      baseEnv: { PATH: '/usr/bin:/bin' },
      closeGraceMs: 200,
      terminate: async (_pgid: number, options: { graceMs: number; signal?: AbortSignal }): Promise<TerminateOutcome> => {
        seen.push(options);
        return 'gone';
      },
    });
    await transport.start();
    if (transport.pgid !== undefined) groups.push(transport.pgid);
    await transport.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
