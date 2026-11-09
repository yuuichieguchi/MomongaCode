import type { EntryIo, MomongaPaths } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { memoryAdd } from '../src/commands/memory.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';

const program = () => {
  const ports = { version: '9.9.9', home: '/h', cwd: '/c', terminal: undefined } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: '/c/cache/executables' }),
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
};

const subcommands = (name: string): string[] => program().commands.find((command) => command.name() === name)?.commands.map((command) => command.name()) ?? [];

describe('commands', () => {
  it('registers rule add, list, retire and history', () => {
    expect(subcommands('rule').sort()).toEqual(['add', 'history', 'list', 'retire']);
  });

  it('registers memory history', () => {
    expect(subcommands('memory')).toContain('history');
  });

  it('registers memory add, which a person uses to seed a memory without a model', () => {
    expect(subcommands('memory')).toContain('add');
  });

  it('refuses a user memory bound to a path before it contacts the daemon', async () => {
    const ports = { cwd: '/c', stdout: { write: () => undefined } } as unknown as CliPorts;
    await expect(memoryAdd(ports, {} as MomongaPaths, 'a note', { user: true, paths: ['a.ts'], json: false })).rejects.toThrow(/--path .* --user/);
  });
});
