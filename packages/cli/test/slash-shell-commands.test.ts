import { DEFAULT_KEY_TABLE } from '../src/tui/keys/table.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryIo } from '@momonga/foundation';
import type { CliPorts } from '../src/ports.ts';
import { createShellPort } from '../src/program.ts';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { SCREEN_COMMAND_NAMES, SHELL_SLASH_COMMANDS } from '../src/tui/commands/shell-commands.ts';
import { createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { fakeBackend } from './fake-backend.ts';
import { createFoundServers } from '../src/tui/models/context.ts';
import { NO_HELPER } from './no-helper.ts';

const spies = vi.hoisted(() => ({
  showCost: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  showStatus: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  listJobs: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  showTrace: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  mcpList: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  mcpLogin: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  memoryAdd: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  memoryReview: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  ruleAdd: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  contextImprove: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  guidelineList: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  policyVerify: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
  probeModel: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
}));

vi.mock('../src/commands/cost.ts', async (original) => ({ ...(await original<object>()), showCost: spies.showCost }));
vi.mock('../src/commands/runs.ts', async (original) => ({ ...(await original<object>()), showStatus: spies.showStatus }));
vi.mock('../src/commands/jobs.ts', async (original) => ({ ...(await original<object>()), listJobs: spies.listJobs }));
vi.mock('../src/commands/trace.ts', async (original) => ({ ...(await original<object>()), showTrace: spies.showTrace }));
vi.mock('../src/commands/mcp.ts', async (original) => ({ ...(await original<object>()), mcpList: spies.mcpList, mcpLogin: spies.mcpLogin }));
vi.mock('../src/commands/memory.ts', async (original) => ({ ...(await original<object>()), memoryAdd: spies.memoryAdd, memoryReview: spies.memoryReview }));
vi.mock('../src/commands/rule.ts', async (original) => ({ ...(await original<object>()), ruleAdd: spies.ruleAdd }));
vi.mock('../src/commands/context.ts', async (original) => ({ ...(await original<object>()), contextImprove: spies.contextImprove, guidelineList: spies.guidelineList }));
vi.mock('../src/commands/policy.ts', async (original) => ({ ...(await original<object>()), policyVerify: spies.policyVerify }));
vi.mock('../src/commands/gateway.ts', async (original) => ({ ...(await original<object>()), probeModel: spies.probeModel }));

vi.mock('../src/paths.ts', () => ({ pathsOf: async () => ({}) }));

const home = '/home/user';

const shellPort = () => {
  const ports = { version: '9.9.9', platform: process.platform, home, cwd: home, terminal: undefined, env: {}, stdout: { write: () => undefined }, stderr: { write: () => undefined } } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return createShellPort({
    ports,
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
};

const slashContext = () => {
  const infos: string[] = [];
  const backgrounds: { label: string; done: Promise<unknown> }[] = [];
  const controller = new AbortController();
  const context = {
    mode: 'manual',
    model: 'm',
    found: createFoundServers(),
    wait: <T,>(_phase: string, work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal),
    toast: () => undefined,
    refreshConnection: async () => undefined,
    bypassAllowed: false,
    autoAvailable: false,
    commands: DEFAULT_SLASH_COMMANDS,
    backend: fakeBackend(),
    info: (text: string) => void infos.push(text),
    background: <T,>(label: string, work: (signal: AbortSignal) => Promise<T>) => {
      const done = work(controller.signal);
      backgrounds.push({ label, done: done.catch(() => undefined) });
      return done;
    },
    shell: shellPort(),
    screen: { current: () => 'fullscreen', set: async () => undefined },
    keys: DEFAULT_KEY_TABLE,
    negotiation: 'unknown',
    display: { a11y: () => ({ screenReader: false, reducedMotion: false }) },
  } as unknown as SlashContext;
  return { context, infos, backgrounds, controller };
};

const run = async (line: string, context: SlashContext) => {
  const [name, ...rest] = line.slice(1).split(' ');
  const command = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find(name ?? '');
  if (command === undefined) throw new Error(`/${name} is not a slash command`);
  await command.run(rest.join(' '), context);
};

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockClear();
});

type Case = { line: string; spy: keyof typeof spies; args: unknown[]; background: boolean; from?: number };

const CASES: readonly Case[] = [
  { line: '/cost --breakdown', spy: 'showCost', args: [expect.objectContaining({ breakdown: true, all: false })], background: true },
  { line: '/status run-1 --json', spy: 'showStatus', args: ['run-1', true], background: true },
  { line: '/jobs sess-1', spy: 'listJobs', args: ['sess-1', false], background: true },
  { line: '/trace run-2', spy: 'showTrace', args: ['run-2', expect.objectContaining({ json: false, content: false })], background: true },
  { line: '/mcp list --json', spy: 'mcpList', args: [true], background: true },
  { line: '/mcp login docs --no-browser', spy: 'mcpLogin', args: ['docs', expect.objectContaining({ openBrowser: false })], background: true },
  { line: '/memory add use pnpm --user', spy: 'memoryAdd', args: ['use pnpm', expect.objectContaining({ user: true })], background: true },
  { line: '/memory review', spy: 'memoryReview', args: [expect.objectContaining({ json: false })], background: true },
  { line: '/rule add Bash no pushing --kind constraint --deny Bash(git:*)', spy: 'ruleAdd', args: ['Bash', 'no pushing', expect.objectContaining({ enforcement: { behavior: 'deny', rule: 'Bash(git:*)' } })], background: true },
  { line: '/context improve --dataset d.json --model a --token-cap 5 --outcome o.json --yes', spy: 'contextImprove', args: [expect.objectContaining({ dataset: 'd.json', model: 'a', tokenCap: 5, outcome: 'o.json', yes: true })], background: true },
  { line: '/context guideline list', spy: 'guidelineList', args: [], background: true },
  { line: '/policy verify --json', spy: 'policyVerify', args: [expect.objectContaining({ json: true })], background: true },
  { line: '/gateway probe fm --samples 2', spy: 'probeModel', args: ['fm', expect.objectContaining({ samples: 2 })], background: true },
];

describe('the shell commands that have a slash form', () => {
  it.each([...new Set(['cost', 'status', 'jobs', 'trace', 'mcp', 'memory', 'rule', 'context', 'policy', 'gateway'])])('/%s is a default slash command with a description and a usage', (name) => {
    const command = DEFAULT_SLASH_COMMANDS.find((entry) => entry.name === name);
    expect(command?.description).toBeTruthy();
    expect(createSlashRegistry(DEFAULT_SLASH_COMMANDS).find(name)).toBeDefined();
  });

  it('lists every one of them in /help', async () => {
    const { context, infos } = slashContext();
    await run('/help', context);
    for (const command of SHELL_SLASH_COMMANDS) expect(infos.join('\n')).toContain(`/${command.name}`);
  });

  it.each(CASES)('$line calls the function the shell command calls, with the waiting row', async ({ line, spy, args, background, from }) => {
    const { context, backgrounds } = slashContext();
    await run(line, context);
    await Promise.all(backgrounds.map((entry) => entry.done));
    const calls = spies[spy].mock.calls as unknown as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(from ?? 2)).toEqual(args);
    expect(backgrounds).toHaveLength(background ? 1 : 0);
  });

  it('shows what the command writes, and the usage error of a bad flag, as notes', async () => {
    spies.showCost.mockImplementationOnce(async (ports: CliPorts) => {
      ports.stdout.write('cost: $0.01\n');
      return 0;
    });
    const { context, infos } = slashContext();
    await run('/cost', context);
    expect(infos).toEqual(['cost: $0.01']);
    infos.length = 0;
    await run('/cost --nope', context);
    expect(infos.join('\n')).toContain("unknown option '--nope'");
    expect(spies.showCost).toHaveBeenCalledTimes(1);
  });

  it('reads quotes in a typed line as the shell does: a quoted rule is one argument', async () => {
    const { context, backgrounds } = slashContext();
    await run('/rule add x text --deny "Bash(npm test:*)"', context);
    await Promise.all(backgrounds.map((entry) => entry.done));
    expect(spies.ruleAdd.mock.calls[0]?.slice(2)).toEqual(['x', 'text', expect.objectContaining({ enforcement: { behavior: 'deny', rule: 'Bash(npm test:*)' } })]);
  });

  it('keeps a quoted path with a space whole, and an escaped space too', async () => {
    const seen: string[][] = [];
    const { context, backgrounds } = slashContext();
    const shell = { run: async (argv: readonly string[]) => (seen.push([...argv]), 0) };
    await run('/policy verify --secret "/a b" --mandate it\\ s', { ...context, shell } as unknown as SlashContext);
    await Promise.all(backgrounds.map((entry) => entry.done));
    expect(seen).toEqual([['policy', 'verify', '--secret', '/a b', '--mandate', 'it s']]);
  });

  it('refuses a line with an unclosed quote and runs nothing', async () => {
    const seen: string[][] = [];
    const { context, infos } = slashContext();
    const shell = { run: async (argv: readonly string[]) => (seen.push([...argv]), 0) };
    await run('/policy verify --secret "/a b', { ...context, shell } as unknown as SlashContext);
    expect(seen).toEqual([]);
    expect(infos.join('\n')).toContain('unclosed');
  });

  it('runs /cost with the waiting row, and esc aborts the signal the command runs under', async () => {
    const { context, backgrounds, controller } = slashContext();
    let seen: AbortSignal | undefined;
    const shell = {
      run: (_argv: readonly string[], io: { signal: AbortSignal }) => {
        seen = io.signal;
        return new Promise<number>((resolve) => io.signal.addEventListener('abort', () => resolve(130), { once: true }));
      },
    };
    await run('/cost', { ...context, shell } as unknown as SlashContext);
    expect(backgrounds.map((entry) => entry.label)).toEqual(['/cost']);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    await Promise.all(backgrounds.map((entry) => entry.done));
    expect(seen?.aborted).toBe(true);
  });

  it('hands /report with no id to the momonga report form under the waiting row, and esc stops it', async () => {
    const seen: string[][] = [];
    const { context, backgrounds, controller, infos } = slashContext();
    const shell = {
      run: (argv: readonly string[], io: { signal: AbortSignal }) => {
        seen.push([...argv]);
        return new Promise<number>((_resolve, reject) => io.signal.addEventListener('abort', () => reject(io.signal.reason)));
      },
    };
    await run('/report', { ...context, shell } as unknown as SlashContext);
    expect(backgrounds.map((entry) => entry.label)).toEqual(['/report']);
    expect(seen).toEqual([['report']]);
    controller.abort();
    await Promise.all(backgrounds.map((entry) => entry.done));
    await Promise.resolve();
    expect(infos.some((line) => line.startsWith('/report stopped: '))).toBe(true);
  });

  it('refuses /auth login with the usage and the way to sign in, and runs nothing', async () => {
    const seen: string[][] = [];
    const { context, infos, backgrounds } = slashContext();
    const shell = { run: async (argv: readonly string[]) => (seen.push([...argv]), 0) };
    await run('/auth login', { ...context, shell } as unknown as SlashContext);
    expect(seen).toEqual([]);
    expect(backgrounds).toEqual([]);
    expect(infos.join('\n')).toContain('usage: /auth status [--json] | logout <account>');
    expect(infos.join('\n')).toContain('/login');
  });

  it.each(SHELL_SLASH_COMMANDS.filter((command) => command.subcommands !== undefined && !SCREEN_COMMAND_NAMES.includes(command.name)).map((command) => command.name))('/%s with no subcommand lists its subcommands with what each does, runs nothing and reports no failure', async (name) => {
    const seen: string[][] = [];
    const { context, infos, backgrounds } = slashContext();
    const shell = { run: async (argv: readonly string[]) => (seen.push([...argv]), 2) };
    await run(`/${name}`, { ...context, shell } as unknown as SlashContext);
    const entry = SHELL_SLASH_COMMANDS.find((command) => command.name === name);
    const shown = infos.join('\n');
    expect(seen).toEqual([]);
    expect(backgrounds).toEqual([]);
    expect(shown).toContain(`/${name} has these subcommands:`);
    for (const subcommand of entry?.subcommands ?? []) expect(shown).toMatch(new RegExp(`/${name} ${subcommand.name} +${subcommand.description.replace(/[()]/g, '\\$&')}`));
    expect(shown).not.toContain('exited with code');
    expect(shown).not.toContain('Usage:');
  });

  it('/context with no subcommand shows improve and guideline with their descriptions', async () => {
    const { context, infos } = slashContext();
    await run('/context', context);
    expect(infos.join('\n')).toBe(
      [
        '/context has these subcommands:',
        '  /context improve    improve how the context is compacted, from the failures a bench shows',
        '  /context guideline  inspect, adopt and roll back the compaction guideline',
        'usage: /context improve [--candidates <n>] [--dataset <file>] [--model <model>] [--token-cap <n>] [--outcome <file>] [--yes] | guideline adopt <file> | guideline list | guideline rollback <version>',
      ].join('\n'),
    );
  });

  it('/context improve with an invalid --seed passes through to Commander without opening a confirmation modal', async () => {
    const { context, infos } = slashContext();
    const choose = vi.fn();
    await run('/context improve --seed nope', { ...context, overlays: { ...context.overlays, choose } } as unknown as SlashContext);
    expect(choose).not.toHaveBeenCalled();
    expect(infos.join('\n')).toContain("option '--seed <n>' argument 'nope' is invalid");
  });

  it('an unknown subcommand is reported as unknown with the valid ones, and runs nothing', async () => {
    const seen: string[][] = [];
    const { context, infos } = slashContext();
    const shell = { run: async (argv: readonly string[]) => (seen.push([...argv]), 0) };
    await run('/gateway nope', { ...context, shell } as unknown as SlashContext);
    expect(seen).toEqual([]);
    expect(infos.join('\n')).toContain('/gateway has no subcommand nope; it has these subcommands:');
    expect(infos.join('\n')).toContain('  /gateway probe  ');
  });

  it('reports a non-zero exit code', async () => {
    spies.policyVerify.mockResolvedValueOnce(2);
    const { context, infos, backgrounds } = slashContext();
    await run('/policy verify --json', context);
    await Promise.all(backgrounds.map((entry) => entry.done));
    expect(infos.at(-1)).toBe('/policy exited with code 2');
  });

  it('passes the signal of the background task to the command, so esc cancels it', async () => {
    let seen: AbortSignal | undefined;
    spies.probeModel.mockImplementationOnce(async (_ports: unknown, _paths: unknown, _target: string, options: { interrupt: AbortSignal }) => {
      seen = options.interrupt;
      return 0;
    });
    const { context, backgrounds, controller } = slashContext();
    await run('/gateway probe fm', context);
    await Promise.all(backgrounds.map((entry) => entry.done));
    expect(seen).toBe(controller.signal);
  });
});
