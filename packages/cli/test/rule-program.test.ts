import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
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
    policyVerify: () => nodePolicyVerifyHost(ports, { cacheBase: '/c/cache' }),
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
});
