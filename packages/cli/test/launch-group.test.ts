import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_LAUNCH, hostProcessGroupPort } from '@momonga/foundation';
import type { ProcessGroupPort } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { nodeWorkspaceProbeOf } from '../src/node-ports.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

let workspace = '';

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-launch-group-')));
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
    const probe = nodeWorkspaceProbeOf({ commandOf: async (command) => ({ file: '/bin/sh', args: ['-c', command], protection: CONTROL_PLANE_LAUNCH }) }, recording)({ PATH: '/usr/bin:/bin' });
    expect(await probe.run(`echo $$ > ${pidFile}; sleep 30`, 500, workspace)).toEqual({ exitCode: null, timedOut: true });
    const leader = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(signalled).toEqual([{ pgid: leader, signal: 'SIGKILL' }]);
  });
});
