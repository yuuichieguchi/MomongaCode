import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMomongaDirs, hostProcessGroupPort, momongaPaths, systemTiming } from '@momonga/foundation';
import { createWorkspaceProbe, nodeWorkspaceFiles } from '@momonga/eval';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { nodeWorkspaceSandbox } from '../src/node-ports.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const NO_DECLARED_CREDENTIALS = { models: { connections: [] }, credentials: { env: [], keep: [], valuePatterns: [] } };

const PLATFORM_SANDBOX = process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' && fs.existsSync('/usr/bin/bwrap') ? 'bubblewrap' : undefined;

let root = '';
let home = '';
let workspace = '';

beforeEach(() => {
  root = createTempDir();
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
  it.skipIf(PLATFORM_SANDBOX === undefined)('an oracle command that writes outside its workspace and its scratch is denied; one that writes into its workspace or its own scratch (TMPDIR, removed when it ends) is not', async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    const paths = momongaPaths(home, process.platform, env);
    await ensureMomongaDirs(paths);
    const warnings: string[] = [];
    const probe = createWorkspaceProbe({
      env,
      sandbox: nodeWorkspaceSandbox({ home, platform: process.platform, env, signal: new AbortController().signal, sandbox: PLATFORM_SANDBOX ?? 'none', network: 'deny', warn: (text) => warnings.push(text), credentialNaming: NO_DECLARED_CREDENTIALS }),
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
    expect(await probe.run('test -n "$TMPDIR" && echo x > "$TMPDIR/scratch.txt" && test -f "$TMPDIR/scratch.txt"', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    expect(await probe.run(`echo "$TMPDIR" > ${path.join(workspace, 'scratch-path.txt')}`, 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    const scratch = fs.readFileSync(path.join(workspace, 'scratch-path.txt'), 'utf8').trim();
    expect(scratch.startsWith(fs.realpathSync(paths.tmp.sessions))).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('under sandbox none an oracle command runs as a tool command does, with the same sentence', async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    await ensureMomongaDirs(momongaPaths(home, process.platform, env));
    const warnings: string[] = [];
    const probe = createWorkspaceProbe({
      env,
      sandbox: nodeWorkspaceSandbox({ home, platform: process.platform, env, signal: new AbortController().signal, sandbox: 'none', network: 'deny', warn: (text) => warnings.push(text), credentialNaming: NO_DECLARED_CREDENTIALS }),
      files: nodeWorkspaceFiles,
      timing: systemTiming,
      groups: hostProcessGroupPort(),
    });
    expect(await probe.run('echo x > made.txt', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    expect(warnings[0]).toBe('sandbox is none: Bash asks before every command');
  });

  it.skipIf(process.platform === 'win32')('an oracle command gets the environment a tool command gets: a credential-named variable is withheld, the Bash additions are set, and node on the PATH is still found', async () => {
    const nodeDirectory = path.dirname(process.execPath);
    const env = { PATH: `${nodeDirectory}:/usr/bin:/bin`, HOME: home, MY_API_TOKEN: 'secret-value' };
    await ensureMomongaDirs(momongaPaths(home, process.platform, env));
    const probe = createWorkspaceProbe({
      env,
      sandbox: nodeWorkspaceSandbox({
        home,
        platform: process.platform,
        env,
        signal: new AbortController().signal,
        sandbox: 'none',
        network: 'deny',
        warn: () => undefined,
        credentialNaming: NO_DECLARED_CREDENTIALS,
      }),
      files: nodeWorkspaceFiles,
      timing: systemTiming,
      groups: hostProcessGroupPort(),
    });
    expect(await probe.run('[ -z "${MY_API_TOKEN+x}" ]', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    expect(await probe.run('[ "$PAGER" = cat ] && [ "$GIT_TERMINAL_PROMPT" = 0 ]', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
    expect(await probe.run('node --version > /dev/null', 30_000, workspace)).toEqual({ exitCode: 0, timedOut: false });
  });
});
