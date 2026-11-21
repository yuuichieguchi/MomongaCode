import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { freshHome } from './fresh-home.ts';
import { NO_HELPER } from './no-helper.ts';

const probed = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../src/commands/gateway.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/gateway.ts')>()),
  probeModel: async () => {
    probed.calls += 1;
    return 0;
  },
}));

const parse = async (stepTimeout: string): Promise<void> => {
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const sink = { write: () => true };
  const interrupt = new AbortController().signal;
  const ports = { version: '9.9.9', interrupt, home: freshHome(), cwd: '/c', env: {}, platform: process.platform, terminal: {}, stdout: sink, stderr: sink, stdin: { isTerminal: true, bytes: async function* () {} } } as unknown as CliPorts;
  const program = buildProgram(
    {
      ports,
      entries,
      update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS }),
      interrupt,
      helper: NO_HELPER,
      entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
      complete: () => undefined,
    },
    { embedded: true },
  );
  await program.parseAsync(['gateway', 'probe', 'local', '--step-timeout', stepTimeout], { from: 'user' });
};

describe('the probe step timeout is refused at the flag beyond the host timer range', () => {
  it('accepts the largest whole number of seconds a host timer holds', async () => {
    probed.calls = 0;
    await parse('2147483');
    expect(probed.calls).toBe(1);
  });

  it('refuses a value one second beyond it before the probe starts', async () => {
    probed.calls = 0;
    await expect(parse('2147484')).rejects.toThrow(/2147483/);
    expect(probed.calls).toBe(0);
  });
});
