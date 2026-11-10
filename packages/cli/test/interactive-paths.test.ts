import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EntryIo } from '@momonga/foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { nodePorts } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { testHostPath } from '@momonga/testkit';

const seen = vi.hoisted(() => ({ stateModeAtHandOff: [] as Array<number | undefined> }));

vi.mock('../src/tui/run-interactive.tsx', async () => {
  const fsModule = await import('node:fs');
  return {
    runInteractive: async (_ports: unknown, paths: { state: string }) => {
      seen.stateModeAtHandOff.push(fsModule.existsSync(paths.state) ? fsModule.statSync(paths.state).mode & 0o777 : undefined);
      return 0;
    },
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('interactive session on a HOME that has never run momonga', () => {
  it('receives its paths only once the private ~/.momonga tree exists, since its history lives in the state directory', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-home-')));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const ports: CliPorts = { ...nodePorts('9.9.9'), home, cwd: home, env: { PATH: testHostPath('/usr/bin:/bin'), HOME: home }, terminal: {} as CliPorts['terminal'] };
    const entry = async (): Promise<number> => 0;
    const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
    const program = buildProgram({
      ports,
      policyVerify: () => nodePolicyVerifyHost(ports, { executables: path.join(home, 'cache', 'executables') }),
      entries,
      update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
      interrupt: new AbortController().signal,
      entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
      complete: () => undefined,
    });
    program.exitOverride();
    seen.stateModeAtHandOff.length = 0;

    await program.parseAsync([], { from: 'user' });

    expect(seen.stateModeAtHandOff).toEqual([0o700]);
    expect(fs.statSync(path.join(home, '.momonga')).mode & 0o777).toBe(0o700);
  });
});
