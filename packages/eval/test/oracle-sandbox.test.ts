import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_LAUNCH, hostProcessGroupPort, systemTiming } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createWorkspaceProbe, gradeChecks, nodeWorkspaceFiles } from '../src/index.ts';
import type { CommandSandbox } from '../src/index.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DENIED_EXIT = 126;
const EVIDENCE = 'acceptance';

let root = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-oracle-')));
  fs.mkdirSync(path.join(root, 'work'));
  fs.mkdirSync(path.join(root, 'base'));
  fs.mkdirSync(path.join(root, 'outside'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const writesOnlyIn = (allowed: (workspace: string) => string): CommandSandbox => ({
  commandOf: async (command, workspace) => ({
    file: '/bin/sh',
    args: ['-c', command.includes(allowed(workspace)) ? command : `exit ${DENIED_EXIT}`],
    protection: CONTROL_PLANE_LAUNCH,
  }),
});

describe('the oracle commands run through the sandbox port', () => {
  it.skipIf(process.platform === 'win32')('an oracle command that writes outside the workspace is denied by the port, and nothing is written there', async () => {
    const leak = path.join(root, 'outside', 'leak.txt');
    const probe = createWorkspaceProbe({ env: { PATH: '/usr/bin:/bin' }, sandbox: writesOnlyIn((workspace) => workspace), files: nodeWorkspaceFiles, timing: systemTiming, groups: hostProcessGroupPort() });
    const grade = await gradeChecks({
      checks: [{ id: 'leak', kind: 'command', run: `echo x > ${leak}`, expectExit: 0, evidence: EVIDENCE, timeoutMs: 30_000 }],
      graderFiles: {},
      workspace: path.join(root, 'work'),
      base: path.join(root, 'base'),
      probe,
      files: nodeWorkspaceFiles,
    });
    expect(grade).toEqual({ met: false, checks: [{ id: 'leak', passed: false, reason: 'exit' }] });
    expect(fs.existsSync(leak)).toBe(false);
  });
});
