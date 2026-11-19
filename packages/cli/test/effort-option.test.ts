import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { freshHome } from './fresh-home.ts';
import { NO_HELPER } from './no-helper.ts';

const seen = vi.hoisted(() => ({ headless: [] as Record<string, unknown>[] }));

vi.mock('../src/run/headless.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run/headless.ts')>()),
  runHeadless: async (_ports: unknown, _paths: unknown, options: Record<string, unknown> & { prompt: () => Promise<string> }) => {
    seen.headless.push({ ...options, prompt: await options.prompt() });
    return 0;
  },
}));

const programOf = () => {
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const written: string[] = [];
  const sink = { write: (text: string) => written.push(text) > 0 };
  const interrupt = new AbortController().signal;
  const ports = { version: '9.9.9', interrupt, home: freshHome(), env: {}, platform: process.platform, cwd: '/c', stdout: sink, stderr: sink, stdin: { isTerminal: true, bytes: async function* () {} } } as unknown as CliPorts;
  const program = buildProgram(
    {
      ports,
      entries,
      update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
      interrupt,
      helper: NO_HELPER,
      entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
      complete: () => undefined,
    },
    { embedded: true },
  );
  program.exitOverride();
  return { program, written };
};

describe('--effort', () => {
  it('carries the reasoning effort of the command line to the session the run creates', async () => {
    const { program } = programOf();
    await program.parseAsync(['-p', 'hello', '--effort', 'high'], { from: 'user' });
    expect(seen.headless.at(-1)).toMatchObject({ effort: 'high' });
  });

  it('refuses a level that is not on the reasoning effort ladder', async () => {
    const { program, written } = programOf();
    await expect(program.parseAsync(['-p', 'hello', '--effort', 'huge'], { from: 'user' })).rejects.toThrow();
    expect(written.join('')).toContain("'huge' is invalid");
  });
});
