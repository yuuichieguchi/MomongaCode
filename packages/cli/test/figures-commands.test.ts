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
import { PRODUCIBLE_FIGURES } from '@momonga/eval';

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

const commandAt = (root: Command, words: readonly string[]): Command | undefined =>
  words.reduce<Command | undefined>((command, word) => command?.commands.find((child) => child.name() === word), root);

describe('every producible figure names a registered command and options (cli-commands-C31)', () => {
  it.each(PRODUCIBLE_FIGURES)('$figure: momonga $command', (figure) => {
    const command = commandAt(program(), figure.command);
    expect(command, figure.command.join(' ')).toBeDefined();
    const known = new Set(command?.options.map((option) => option.long));
    expect(figure.options.filter((option) => !known.has(option))).toEqual([]);
  });
});
