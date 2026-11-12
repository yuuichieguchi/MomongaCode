import type { EntryIo } from '@momonga/foundation';
import { EXIT_USAGE } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram, exitOfFailure } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { freshHome } from './fresh-home.ts';
import { NO_HELPER } from './no-helper.ts';

const seen = vi.hoisted(() => ({ headless: [] as Record<string, unknown>[], interactive: [] as Record<string, unknown>[] }));

vi.mock('../src/run/headless.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run/headless.ts')>()),
  runHeadless: async (_ports: unknown, _paths: unknown, options: Record<string, unknown> & { prompt: () => Promise<string> }) => {
    seen.headless.push({ ...options, prompt: await options.prompt() });
    return 0;
  },
}));

vi.mock('../src/tui/run-interactive.tsx', () => ({
  runInteractive: async (_ports: unknown, _paths: unknown, _terminal: unknown, options: Record<string, unknown>) => {
    seen.interactive.push(options);
    return 0;
  },
}));

const ran = async (...args: string[]): Promise<{ code: number | undefined; written: string }> => {
  seen.headless.length = 0;
  seen.interactive.length = 0;
  const written: string[] = [];
  const completed: number[] = [];
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const sink = { write: (text: string) => (written.push(text), true) };
  const interrupt = new AbortController().signal;
  const ports = { version: '9.9.9', interrupt, home: freshHome(), cwd: '/c', env: {}, platform: process.platform, terminal: {}, stdout: sink, stderr: sink, stdin: { isTerminal: true, bytes: async function* () {} } } as unknown as CliPorts;
  const program = buildProgram(
    {
      ports,
      entries,
      update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
      interrupt,
      helper: NO_HELPER,
      entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
      complete: (code) => void completed.push(code),
    },
    { embedded: true },
  );
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    return { code: exitOfFailure(error, sink), written: written.join('') };
  }
  return { code: completed.at(-1), written: written.join('') };
};

const BOUNDS = ['--until', 'npm test', '--require', 'the changelog is updated', '--mandate', 'night', '--max-cost-usd', '1.5'];

const BOUND = {
  mandate: { profile: 'night', completion: { conditions: [{ command: 'npm test' }], requirements: ['the changelog is updated'] } },
  limits: { maxCostUsd: 1.5 },
};

describe('every bound the person types reaches the runs of the mode it is given in', () => {
  it('reaches a headless run', async () => {
    expect((await ran('-p', 'refactor', ...BOUNDS)).code).toBe(0);

    expect(seen.headless[0]).toMatchObject(BOUND);
  });

  it('reaches the runs of an interactive session, with a first prompt and without one', async () => {
    expect((await ran('refactor', ...BOUNDS)).code).toBe(0);
    expect(seen.interactive[0]).toMatchObject({ prompt: 'refactor', ...BOUND });

    expect((await ran('--max-cost-usd', '2')).code).toBe(0);
    expect(seen.interactive[0]).toMatchObject({ limits: { maxCostUsd: 2 } });
    expect(seen.interactive[0]).not.toHaveProperty('mandate');
  });
});

describe('an option the mode cannot apply is refused by name before any work starts', () => {
  it.each([
    [['-p', 'one', 'two'], '"two"'],
    [['-p', 'one', '--continue', 'two'], '"two"'],
    [['-p', 'one', '--screen-reader'], '--screen-reader'],
    [['-p', 'one', '--resume'], '--resume'],
    [['hello', '--verbose'], '--verbose'],
    [['hello', '--output-format', 'json'], '--output-format'],
  ])('%j exits 2 and names %s', async (args, named) => {
    const result = await ran(...args);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.written).toContain(named);
    expect(seen.headless).toEqual([]);
    expect(seen.interactive).toEqual([]);
  });

  it('the default output format of an interactive session is no typed option', async () => {
    expect((await ran('hello')).code).toBe(0);
    expect(seen.interactive).toHaveLength(1);
  });
});
