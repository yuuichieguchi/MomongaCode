import { describe, expect, it } from 'vitest';
import type { CommanderError } from 'commander';
import type { EntryIo } from '@momonga/foundation';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';

const program = () => {
  const reads: string[] = [];
  const ports = {
    version: '9.9.9',
    home: '/h',
    cwd: '/w',
    terminal: undefined,
    stdout: { write: () => undefined },
    files: {
      readText: async (file: string) => {
        reads.push(file);
        throw new Error('the dataset must not be read');
      },
    },
  } as unknown as CliPorts;
  const built = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { cacheBase: '/w/cache' }),
    entries: {} as DaemonEntries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  const quiet = (command: typeof built): void => {
    command.exitOverride().configureOutput({ writeErr: () => undefined });
    command.commands.forEach((nested) => quiet(nested as typeof built));
  };
  quiet(built);
  return { built, reads };
};

const parse = (args: string[]) => {
  const { built, reads } = program();
  return { reads, parsed: built.parseAsync(args, { from: 'user' }) };
};

const assertRejected = async (args: string[], pattern: RegExp) => {
  const { parsed, reads } = parse(args);
  const error = (await parsed.then(() => undefined, (reason: unknown) => reason)) as CommanderError | Error | undefined;
  expect(error?.message).toMatch(pattern);
  expect(error?.message).not.toMatch(/unknown command/);
  expect(reads).toEqual([]);
};

describe('momonga context improve', () => {
  it('guards a command with no input: --dataset is required', async () => {
    await assertRejected(['context', 'improve', '--model', 'real', '--alias', 'opus'], /--dataset/);
  });

  it('guards a report of unknown provenance: --model fake|real is required before the dataset is read', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--alias', 'opus'], /--model/);
  });

  it('guards an invented kind: --model takes fake or real only', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'gpt', '--alias', 'opus'], /--model.*fake.*real/);
  });

  it('guards an unchosen analysis model: --alias is required', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'real'], /--alias/);
  });
});

describe('momonga context guideline rollback', () => {
  it('guards a typo: the version must be an integer of at least 1', async () => {
    await assertRejected(['context', 'guideline', 'rollback', 'latest'], /integer/);
  });
});
