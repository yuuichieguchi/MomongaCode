import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_LAUNCH, hostProcessGroupPort, launchGroupLeader, systemTiming } from '@momonga/foundation';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createWorkspaceProbe, gradeChecks, nodeWorkspaceFiles } from '../src/index.ts';
import type { CommandSandbox } from '../src/index.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DENIED_EXIT = 126;
const EVIDENCE = 'acceptance';

let root = '';

beforeEach(() => {
  root = createTempDir();
  fs.mkdirSync(path.join(root, 'work'));
  fs.mkdirSync(path.join(root, 'base'));
  fs.mkdirSync(path.join(root, 'outside'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const launched = async (file: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>) => {
  const { pgid, onExit } = await launchGroupLeader({ file, args, cwd, env, stdio: ['ignore', 'ignore', 'ignore'], protection: CONTROL_PLANE_LAUNCH });
  if (pgid === undefined) throw new Error(`${file} started with no process group`);
  return { pgid, exited: new Promise<{ code: number | null }>((resolve, reject) => onExit(({ code }) => resolve({ code }), reject)) };
};

const writesOnlyIn = (allowed: (workspace: string) => string): CommandSandbox => ({
  start: async (command, workspace, env) => launched('/bin/sh', ['-c', command.includes(allowed(workspace)) ? command : `exit ${DENIED_EXIT}`], workspace, env),
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
