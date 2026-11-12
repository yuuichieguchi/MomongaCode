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
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
};

const GATE_DOCUMENT_VARIABLE = 'MOMONGA_RELEASE_GATE_DOCUMENT';

type Invocation = { words: string[]; options: string[] };

const invocationsOf = (text: string): Invocation[] =>
  [...text.matchAll(/`momonga ([^`]+)`/g)].map((match) => {
    const parts = (match[1] ?? '').split(/\s+/);
    const firstArgument = parts.findIndex((part) => !/^[a-z][a-z-]*$/.test(part));
    const words = firstArgument === -1 ? parts : parts.slice(0, firstArgument);
    return { words, options: parts.filter((part) => part.startsWith('--')).map((part) => part.split('=')[0] ?? part) };
  });

const missingIn = (root: Command, invocation: Invocation): string[] => {
  let command = root;
  for (const word of invocation.words) {
    const next = command.commands.find((child) => child.name() === word || child.aliases().includes(word));
    if (next === undefined) break;
    command = next;
  }
  const where = `momonga ${invocation.words.join(' ')}`;
  if (command === root) return [`${where}: no such command`];
  const known = new Set(command.options.flatMap((option) => [option.long, option.negate ? option.long?.replace(/^--no-/, '--') : undefined]).filter((name) => name !== undefined));
  return invocation.options.filter((option) => !known.has(option)).map((option) => `${where}: no option ${option}`);
};

describe('the release gate procedure names only commands and options that exist', () => {
  const document = process.env[GATE_DOCUMENT_VARIABLE];
  const title = `every momonga command and option in the document named by ${GATE_DOCUMENT_VARIABLE} is registered`;
  if (document === undefined) {
    it.skip(title, () => undefined);
  } else {
    it(title, () => {
      const root = program();
      expect(invocationsOf(fs.readFileSync(document, 'utf8')).flatMap((invocation) => missingIn(root, invocation))).toEqual([]);
    });
  }
});
