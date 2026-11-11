import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostProcessGroupPort, momongaLayout, protectedAreasOf, systemTiming } from '@momonga/foundation';
import { createWorkspaceProbe, nodeWorkspaceFiles } from '@momonga/eval';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { nodeWorkspaceSandbox } from '../src/node-ports.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PLATFORM_WITH_A_SANDBOX = process.platform === 'darwin' || (process.platform === 'linux' && fs.existsSync('/usr/bin/bwrap'));

let root = '';
let home = '';
let workspace = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-oracle-contract-')));
  home = path.join(root, 'home');
  workspace = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the real sandbox port of the oracle commands (darwin, and linux with bubblewrap; the linux leg runs in the container)', () => {
  it.skipIf(!PLATFORM_WITH_A_SANDBOX)("an oracle command that writes into the product's home is refused, and one that writes into its workspace is not", async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    const [denied] = protectedAreasOf(momongaLayout(home, process.platform, env));
    if (denied === undefined) throw new Error('the layout of the home names no protected area');
    fs.mkdirSync(denied, { recursive: true });
    const probe = createWorkspaceProbe({
      env,
      sandbox: nodeWorkspaceSandbox({ home, platform: process.platform, env, signal: new AbortController().signal }),
      files: nodeWorkspaceFiles,
      timing: systemTiming,
      groups: hostProcessGroupPort(),
    });
    const leak = path.join(denied, 'leak.txt');
    const outcome = await probe.run(`echo x > ${leak}`, 30_000, workspace);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(fs.existsSync(leak)).toBe(false);
    expect(await probe.run('echo x > made.txt', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    expect(fs.readFileSync(path.join(workspace, 'made.txt'), 'utf8')).toBe('x\n');
  });
});
