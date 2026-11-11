import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMomongaDirs, hostProcessGroupPort, momongaPaths, systemTiming } from '@momonga/foundation';
import { createWorkspaceProbe, nodeWorkspaceFiles } from '@momonga/eval';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { nodeWorkspaceSandbox } from '../src/node-ports.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PLATFORM_SANDBOX = process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' && fs.existsSync('/usr/bin/bwrap') ? 'bubblewrap' : undefined;

let root = '';
let home = '';
let workspace = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-oracle-contract-')));
  home = path.join(root, 'home');
  workspace = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, 'outside'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the real sandbox port of the oracle commands is the sandbox of a tool command (darwin, and linux with bubblewrap; the linux leg runs in the container)', () => {
  it.skipIf(PLATFORM_SANDBOX === undefined)('an oracle command that writes outside its workspace is denied, and one that writes into its workspace is not', async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    const paths = momongaPaths(home, process.platform, env);
    await ensureMomongaDirs(paths);
    const warnings: string[] = [];
    const probe = createWorkspaceProbe({
      env,
      sandbox: nodeWorkspaceSandbox({ home, platform: process.platform, env, signal: new AbortController().signal, sandbox: PLATFORM_SANDBOX ?? 'none', network: 'deny', warn: (text) => warnings.push(text) }),
      files: nodeWorkspaceFiles,
      timing: systemTiming,
      groups: hostProcessGroupPort(),
    });
    const leak = path.join(root, 'outside', 'leak.txt');
    const outcome = await probe.run(`echo x > ${leak}`, 30_000, workspace);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(fs.existsSync(leak)).toBe(false);
    expect(await probe.run('echo x > made.txt', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    expect(fs.readFileSync(path.join(workspace, 'made.txt'), 'utf8')).toBe('x\n');
    expect(warnings).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('under sandbox none an oracle command runs as a tool command does, with the same sentence', async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    await ensureMomongaDirs(momongaPaths(home, process.platform, env));
    const warnings: string[] = [];
    const probe = createWorkspaceProbe({
      env,
      sandbox: nodeWorkspaceSandbox({ home, platform: process.platform, env, signal: new AbortController().signal, sandbox: 'none', network: 'deny', warn: (text) => warnings.push(text) }),
      files: nodeWorkspaceFiles,
      timing: systemTiming,
      groups: hostProcessGroupPort(),
    });
    expect(await probe.run('echo x > made.txt', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    expect(warnings[0]).toBe('sandbox is none: Bash asks before every command');
  });
});
