import { DEFAULT_KEY_TABLE } from '../src/tui/keys/table.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryIo } from '@momonga/foundation';
import type { CliPorts } from '../src/ports.ts';
import { createShellPort } from '../src/program.ts';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { SHELL_SLASH_COMMANDS } from '../src/tui/commands/shell-commands.ts';
import { createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { fakeBackend } from './fake-backend.ts';
import { createFoundServers } from '../src/tui/models/context.ts';

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
  listModels: vi.fn(async (...args: never[]) => (args.length >= 0 ? 0 : 1)),
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
vi.mock('../src/commands/models.ts', async (original) => ({ ...(await original<object>()), listModels: spies.listModels }));
vi.mock('../src/commands/gateway.ts', async (original) => ({ ...(await original<object>()), probeModel: spies.probeModel }));

vi.mock('../src/paths.ts', () => ({ pathsOf: async () => ({}) }));

const home = '/home/user';

const shellPort = () => {
  const ports = { version: '9.9.9', platform: process.platform, home, cwd: home, terminal: undefined, env: {}, stdout: { write: () => undefined }, stderr: { write: () => undefined } } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return createShellPort({
    ports,
    policyVerify: () => ({}) as never,
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
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
  { line: '/cost --breakdown', spy: 'showCost', args: [expect.objectContaining({ breakdown: true, all: false })], background: false },
  { line: '/status run-1 --json', spy: 'showStatus', args: ['run-1', true], background: false },
  { line: '/jobs sess-1', spy: 'listJobs', args: ['sess-1', false], background: false },
  { line: '/trace run-2', spy: 'showTrace', args: ['run-2', expect.objectContaining({ json: false, content: false })], background: false },
  { line: '/mcp list --json', spy: 'mcpList', args: [true], background: false },
  { line: '/mcp login docs --no-browser', spy: 'mcpLogin', args: ['docs', expect.objectContaining({ openBrowser: false })], background: true },
  { line: '/memory add use pnpm --user', spy: 'memoryAdd', args: ['use pnpm', expect.objectContaining({ user: true })], background: false },
  { line: '/memory review', spy: 'memoryReview', args: [expect.objectContaining({ json: false })], background: false },
  { line: '/rule add Bash no pushing --kind constraint --deny Bash(git:*)', spy: 'ruleAdd', args: ['Bash', 'no pushing', expect.objectContaining({ enforcement: { behavior: 'deny', rule: 'Bash(git:*)' } })], background: false },
  { line: '/context improve --dataset d.json --model a --token-cap 5 --outcome o.json', spy: 'contextImprove', args: [expect.objectContaining({ dataset: 'd.json', model: 'a', tokenCap: 5, outcome: 'o.json' })], background: true },
  { line: '/context guideline list', spy: 'guidelineList', args: [], background: false },
  { line: '/policy verify --json', spy: 'policyVerify', args: [expect.anything(), expect.objectContaining({ json: true })], background: true },
  { line: '/models --json', spy: 'listModels', from: 1, args: [{ json: true }], background: false },
  { line: '/gateway probe fm --samples 2', spy: 'probeModel', args: ['fm', expect.objectContaining({ samples: 2 })], background: true },
];

describe('the shell commands that have a slash form', () => {
  it.each([...new Set(['cost', 'status', 'jobs', 'trace', 'mcp', 'memory', 'rule', 'context', 'policy', 'models', 'gateway'])])('/%s is a default slash command with a description and a usage', (name) => {
    const command = DEFAULT_SLASH_COMMANDS.find((entry) => entry.name === name);
    expect(command?.description).toBeTruthy();
    expect(createSlashRegistry(DEFAULT_SLASH_COMMANDS).find(name)).toBeDefined();
  });

  it('lists every one of them in /help', async () => {
    const { context, infos } = slashContext();
    await run('/help', context);
    for (const command of SHELL_SLASH_COMMANDS) expect(infos.join('\n')).toContain(`/${command.name}`);
  });

  it.each(CASES)('$line calls the function the shell command calls', async ({ line, spy, args, background, from }) => {
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

  it('reports a non-zero exit code', async () => {
    spies.listModels.mockResolvedValueOnce(2);
    const { context, infos } = slashContext();
    await run('/models --json', context);
    expect(infos.at(-1)).toBe('/models exited with code 2');
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
