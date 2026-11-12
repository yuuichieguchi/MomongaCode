import type { EntryIo } from '@momonga/foundation';
import { PROMPT_TEXT_MAX_CHARS } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import { freshHome } from './fresh-home.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts, StandardInput } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { UsageError } from '../src/usage-error.ts';
import { NO_HELPER } from './no-helper.ts';

const seen = vi.hoisted(() => ({ headless: [] as Record<string, unknown>[] }));

vi.mock('../src/run/headless.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/run/headless.ts')>();
  return {
    ...original,
    runHeadless: async (_ports: unknown, _paths: unknown, options: Record<string, unknown> & { prompt: () => Promise<string> }) => {
      seen.headless.push({ ...options, prompt: await options.prompt() });
      return 0;
    },
  };
});

const piped = (text: string): StandardInput => ({
  isTerminal: false,
  bytes: async function* () {
    yield new TextEncoder().encode(text);
  },
});

const TERMINAL: StandardInput = { isTerminal: true, bytes: async function* () {} };

const run = (stdin: StandardInput, ...args: string[]): Promise<unknown> => {
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const ports = { version: '9.9.9', interrupt: new AbortController().signal, home: freshHome(), cwd: '/c', env: {}, platform: process.platform, stdin } as unknown as CliPorts;
  const built = buildProgram({
    ports,
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  built.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  seen.headless.length = 0;
  return built.parseAsync(args, { from: 'user' });
};

const refusal = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

describe('piped standard input of a headless run', () => {
  it('is given to the run with the prompt', async () => {
    await run(piped('the log\n'), '-p', 'what failed?');
    expect(seen.headless).toHaveLength(1);
    const prompt = String(seen.headless[0]?.['prompt']);
    expect(prompt.startsWith('what failed?')).toBe(true);
    expect(prompt).toContain('the log');
  });

  it('is the prompt when -p has none', async () => {
    await run(piped('explain this folder\n'), '-p');
    expect(seen.headless[0]?.['prompt']).toBe('explain this folder\n');
  });

  it('is not read from a terminal', async () => {
    await run(TERMINAL, '-p', 'question');
    expect(seen.headless[0]?.['prompt']).toBe('question');
  });

  it('refuses -p with no prompt and nothing piped', async () => {
    expect(await refusal(run(TERMINAL, '-p'))).toBeInstanceOf(UsageError);
    expect(seen.headless).toHaveLength(0);
  });

  it('refuses an input over the prompt limit with the usage exit, and names the limit', async () => {
    const error = await refusal(run(piped('x'.repeat(PROMPT_TEXT_MAX_CHARS + 1)), '-p', 'question'));
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain(PROMPT_TEXT_MAX_CHARS.toLocaleString('en-US'));
    expect(seen.headless).toHaveLength(0);
  });
});
