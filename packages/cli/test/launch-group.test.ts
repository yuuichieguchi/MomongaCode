import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_LAUNCH, hostProcessGroupPort, launchGroupLeader } from '@momonga/foundation';
import type { ProcessGroupPort } from '@momonga/foundation';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { nodeWorkspaceProbeOf } from '../src/node-ports.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

let workspace = '';

beforeEach(() => {
  workspace = createTempDir();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the work process the CLI starts for an oracle command is a group leader of the group port', () => {
  it.skipIf(process.platform === 'win32')('a command that outruns its timeout is ended by a signal to its own group, through the port the CLI gives', async () => {
    const host = hostProcessGroupPort();
    const signalled: { pgid: number; signal: NodeJS.Signals }[] = [];
    const recording: ProcessGroupPort = {
      ...host,
      signal: (pgid, signal, options) => {
        signalled.push({ pgid, signal });
        return host.signal(pgid, signal, options);
      },
    };
    const pidFile = path.join(workspace, 'leader.pid');
    const probe = nodeWorkspaceProbeOf(
      {
        start: async (command, cwd, env) => {
          const { pgid, onExit } = await launchGroupLeader({ file: '/bin/sh', args: ['-c', command], cwd, env, stdio: ['ignore', 'ignore', 'ignore'], protection: CONTROL_PLANE_LAUNCH });
          if (pgid === undefined) throw new Error('the command started with no process group');
          return { pgid, exited: new Promise((resolve, reject) => onExit(({ code }) => resolve({ code }), reject)) };
        },
      },
      recording,
    )({ PATH: '/usr/bin:/bin' });
    expect(await probe.run(`echo $$ > ${pidFile}; sleep 30`, 500, workspace)).toEqual({ exitCode: null, timedOut: true });
    const leader = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(signalled).toEqual([{ pgid: leader, signal: 'SIGKILL' }]);
  });
});
