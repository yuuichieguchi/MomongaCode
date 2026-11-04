import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import { freshHome } from './fresh-home.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';

const seen = vi.hoisted(() => ({ headless: [] as Record<string, unknown>[], interactive: [] as Record<string, unknown>[] }));

vi.mock('../src/run/headless.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/run/headless.ts')>();
  return {
    ...original,
    runHeadless: async (_ports: unknown, _paths: unknown, options: Record<string, unknown>) => {
      seen.headless.push(options);
      return 0;
    },
  };
});

vi.mock('../src/tui/run-interactive.tsx', () => ({
  runInteractive: async (_ports: unknown, _paths: unknown, _terminal: unknown, options: Record<string, unknown>) => {
    seen.interactive.push(options);
    return 0;
  },
}));

const harness = () => {
  const out: string[] = [];
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const ports = { version: '9.9.9', home: freshHome(), cwd: '/c', terminal: {} } as unknown as CliPorts;
  const program = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { cacheBase: '/c/cache' }),
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  program.exitOverride().configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => out.push(text) });
  return { program, out };
};

const run = (program: ReturnType<typeof harness>['program'], ...args: string[]): Promise<unknown> => program.parseAsync(args, { from: 'user' });

describe('--model', () => {
  it('names the alias of a headless session', async () => {
    seen.headless.length = 0;
    await run(harness().program, '-p', 'hello', '--model', 'fm-large');
    expect(seen.headless).toHaveLength(1);
    expect(seen.headless[0]).toMatchObject({ prompt: 'hello', modelAlias: 'fm-large' });
  });

  it('names the alias of an interactive session', async () => {
    seen.interactive.length = 0;
    await run(harness().program, '--model', 'fm-large');
    expect(seen.interactive).toHaveLength(1);
    expect(seen.interactive[0]).toMatchObject({ modelAlias: 'fm-large' });
  });

  it('leaves the alias to the default when it is not given', async () => {
    seen.headless.length = 0;
    await run(harness().program, '-p', 'hello');
    expect(seen.headless[0]).not.toHaveProperty('modelAlias');
  });

  it('needs a value', async () => {
    await expect(run(harness().program, '-p', 'hello', '--model')).rejects.toMatchObject({ code: 'commander.optionMissingArgument' });
  });

  it('is listed in the help', async () => {
    const { program, out } = harness();
    await run(program, '--help').catch(() => undefined);
    expect(out.join('')).toContain('--model <alias>');
  });
});
