import fs from 'node:fs';
import path from 'node:path';
import { shortTempBase } from '@momonga/foundation';
import type { EntryIo } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { nodePorts } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { testHostPath } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const freshDir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(shortTempBase(process.platform), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const modeOf = (directory: string): number => fs.statSync(directory).mode & 0o777;

const runCli = async (home: string, args: readonly string[]): Promise<{ codes: number[]; stdout: string; stderr: string }> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const codes: number[] = [];
  const ports: CliPorts = {
    ...nodePorts('9.9.9'),
    home,
    cwd: home,
    env: { PATH: testHostPath('/usr/bin:/bin'), HOME: home },
    terminal: undefined,
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
  };
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const program = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: path.join(home, 'cache', 'executables') }),
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    entryIo: (entryArgs) => ({ argv: [...entryArgs] }) as unknown as EntryIo,
    complete: (code) => void codes.push(code),
  });
  program.exitOverride();
  await program.parseAsync([...args], { from: 'user' });
  return { codes, stdout: stdout.join(''), stderr: stderr.join('') };
};

describe('gateway probe on a HOME that has never run momonga', () => {
  it('creates the private ~/.momonga tree before fm serve is started on its socket under it, and completes the probe', async () => {
    const home = freshDir('mm-home-');
    const fm = await createFakeFm({ dir: freshDir('mm-fm-') });
    fm.configure({ serve: { scenario: 'tools-ok', contextWindow: 8192, contextSizeExposure: 'models' } });
    fs.mkdirSync(path.join(home, '.momonga'), { mode: 0o700 });
    fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify({ models: { targets: { fm: { adapter: 'managed', server: 'fm', binary: fm.binaryPath } }, aliases: { default: 'fm' } } }), { mode: 0o600 });

    const result = await runCli(home, ['gateway', 'probe', 'fm', '--samples', '1']);

    expect(result.codes).toEqual([0]);
    expect(result.stdout).toContain('probed fm: model system, context window 8192 (reported)');
    expect(modeOf(path.join(home, '.momonga'))).toBe(0o700);
    expect(modeOf(path.join(home, '.momonga', 'run'))).toBe(0o700);
    expect(modeOf(path.join(home, '.momonga', 'state'))).toBe(0o700);
  });

  it('brings an existing ~/.momonga that holds only the settings to the private tree before probing a chat-completions target', async () => {
    const home = freshDir('mm-home-');
    const upstream: FakeChatCompletionsServer = await startFakeChatCompletions({ scenario: 'tools-ok', contextWindow: 8192, contextSizeExposure: 'models' });
    cleanups.push(() => upstream.close());
    const root = path.join(home, '.momonga');
    fs.mkdirSync(root, { mode: 0o755 });
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(
      path.join(root, 'settings.json'),
      JSON.stringify({
        models: {
          targets: {
            remote: { adapter: 'chat-completions', provider: 'fake', model: 'system', socketPath: upstream.socketPath, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } },
          },
        },
      }),
      { mode: 0o600 },
    );

    const result = await runCli(home, ['gateway', 'probe', 'remote', '--samples', '1']);

    expect(result.codes).toEqual([0]);
    expect(result.stdout).toContain('probed remote: model system');
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(path.join(root, 'run'))).toBe(0o700);
    expect(modeOf(path.join(root, 'state'))).toBe(0o700);
  });
});
