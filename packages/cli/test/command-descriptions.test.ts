import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';
import type { EntryIo } from '@momonga/foundation';
import { nodeProcess } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';
import { createTempDir } from '@momonga/testkit';

const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const program = (): Command => {
  const home = createTempDir();
  homes.push(home);
  const ports = { version: '9.9.9', home, platform: process.platform, interrupt: new AbortController().signal, cwd: '/c', terminal: undefined, env: {}, process: nodeProcess, stdout: { write: () => undefined }, stderr: { write: () => undefined } } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return buildProgram({
    ports,
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
};

const shown = (command: Command, parents: string): { name: string; description: string }[] =>
  command.commands
    .filter((child) => !(child as unknown as { _hidden: boolean })._hidden)
    .flatMap((child) => {
      const name = `${parents} ${child.name()}`.trim();
      return [{ name, description: child.description() }, ...shown(child, name)];
    });

describe('every command shown in the help has a description (cli-commands-C42)', () => {
  it('no shown command has an empty description', () => {
    expect(shown(program(), '').filter((command) => command.description === '').map((command) => command.name)).toEqual([]);
  });
});

describe('a flag help states the rule the code applies (cli-commands-C42)', () => {
  it('models add --window says the flag wins over the window the server reports', () => {
    const add = program().commands.find((command) => command.name() === 'models')?.commands.find((command) => command.name() === 'add');
    const window = add?.options.find((option) => option.long === '--window');
    expect(window?.description).toBe('the context window of the model; it wins over the window the server reports');
  });
});
