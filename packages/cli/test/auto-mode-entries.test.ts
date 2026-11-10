import { describe, expect, it, vi } from 'vitest';
import type { EntryIo } from '@momonga/foundation';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { fakeBackend } from './fake-backend.ts';
import { createFoundServers } from '../src/tui/models/context.ts';

const spies = vi.hoisted(() => ({
  check: vi.fn(async () => ({ measurement: 'did_not_pass' as const })),
  status: vi.fn(async () => ({ measurement: 'not_measured' as const })),
}));

vi.mock('../src/commands/auto-mode.ts', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, autoModeCheck: spies.check, autoModeStatus: spies.status };
});

const programWith = (interrupt: AbortSignal) => {
  const ports = { version: '9.9.9', home: '/h', cwd: '/c', terminal: undefined, env: {}, stdout: { write: () => undefined }, stderr: { write: () => undefined } } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  const program = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: '/c/cache/executables' }),
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  program.exitOverride();
  return program;
};

const lastOptions = (spy: typeof spies.check): Record<string, unknown> => (spy.mock.calls.at(-1) as unknown as [unknown, Record<string, unknown>] | undefined)?.[1] ?? {};

type Background = <T>(label: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

const slashContext = (overrides: Partial<SlashContext> & Record<string, unknown> = {}) => {
  const infos: string[] = [];
  const signals: AbortSignal[] = [];
  const pending: Promise<unknown>[] = [];
  const controller = new AbortController();
  const background: Background = (_label, work) => {
    signals.push(controller.signal);
    const running = work(controller.signal);
    pending.push(running.catch(() => undefined));
    return running;
  };
  const checks: Record<string, unknown>[] = [];
  const release = Promise.withResolvers<{ measurement: 'did_not_pass' }>();
  const autoMode = {
    check: async (options: Record<string, unknown>) => {
      checks.push(options);
      return release.promise;
    },
    status: async () => ({ measurement: 'not_measured' as const }),
  };
  const context = {
    mode: 'manual',
    model: 'session-model',
    found: createFoundServers(),
    wait: <T>(_phase: string, work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal),
    toast: () => undefined,
    refreshConnection: async () => undefined,
    bypassAllowed: false,
    autoAvailable: true,
    commands: DEFAULT_SLASH_COMMANDS,
    backend: fakeBackend(),
    startRun: async () => undefined,
    info: (text: string) => void infos.push(text),
    clear: () => undefined,
    exit: () => undefined,
    setMode: async () => undefined,
    setModel: async () => undefined,
    background,
    autoMode,
    ...overrides,
  } as unknown as SlashContext;
  return { context, infos, checks, signals, controller, release, pending };
};

const runSlash = (line: string, context: SlashContext) => {
  const [name, ...rest] = line.slice(1).split(' ');
  const command = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find(name ?? '');
  if (command === undefined) throw new Error(`/${name} is not a slash command`);
  return command.run(rest.join(' '), context);
};

describe('momonga auto-mode check and status', () => {
  it('registers check and status under auto-mode', () => {
    const group = programWith(new AbortController().signal).commands.find((command) => command.name() === 'auto-mode');
    expect(group?.commands.map((command) => command.name()).sort()).toEqual(['check', 'status']);
  });

  it('calls autoModeCheck with the named classifier, the agent and the interrupt signal', async () => {
    const interrupt = new AbortController().signal;
    await programWith(interrupt).parseAsync(['auto-mode', 'check', 'guard', '--agent', 'worker'], { from: 'user' });
    expect(spies.check).toHaveBeenCalled();
    expect(lastOptions(spies.check)).toMatchObject({ classifier: 'guard', agent: 'worker' });
    expect(lastOptions(spies.check)['signal']).toBe(interrupt);
  });

  it('leaves the agent outside the TUI to the model new sessions start with, and the classifier to the settings', async () => {
    await programWith(new AbortController().signal).parseAsync(['auto-mode', 'check'], { from: 'user' });
    expect(lastOptions(spies.check)['agent']).toBeUndefined();
    expect(lastOptions(spies.check)['classifier']).toBeUndefined();
  });

  it('calls autoModeStatus for status', async () => {
    await programWith(new AbortController().signal).parseAsync(['auto-mode', 'status', 'guard'], { from: 'user' });
    expect(spies.status).toHaveBeenCalled();
    expect((spies.status.mock.calls.at(-1) as unknown as [unknown, Record<string, unknown>])[1]).toMatchObject({ classifier: 'guard' });
  });
});

describe('/auto-mode in the TUI', () => {
  it('is one of the default slash commands, with check and status in its usage', () => {
    const command = DEFAULT_SLASH_COMMANDS.find((entry) => entry.name === 'auto-mode');
    expect(command).toBeDefined();
    expect(command?.usage).toContain('check');
    expect(command?.usage).toContain('status');
  });

  it('runs the check as a background task with the same options the CLI passes, and returns before it ends', async () => {
    const { context, checks, signals, controller, release, pending } = slashContext();
    await runSlash('/auto-mode check guard --agent worker', context);
    expect(checks).toEqual([expect.objectContaining({ classifier: 'guard', agent: 'worker' })]);
    expect(checks[0]?.['signal']).toBe(controller.signal);
    expect(signals).toHaveLength(1);
    release.resolve({ measurement: 'did_not_pass' });
    await Promise.all(pending);
  });

  it("defaults the agent in the TUI to the session's model", async () => {
    const { context, checks, release, pending } = slashContext();
    await runSlash('/auto-mode check', context);
    expect(checks[0]?.['agent']).toBe('session-model');
    expect(checks[0]?.['classifier']).toBeUndefined();
    release.resolve({ measurement: 'did_not_pass' });
    await Promise.all(pending);
  });
});
