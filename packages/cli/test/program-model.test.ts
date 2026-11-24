import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import { freshHome } from './fresh-home.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';

const seen = vi.hoisted(() => ({
  headless: [] as Record<string, unknown>[],
  interactive: [] as Record<string, unknown>[],
  evaluateContext: [] as Record<string, unknown>[],
  autoModeCheck: [] as Record<string, unknown>[],
  contextImprove: [] as Record<string, unknown>[],
  models: [] as Record<string, unknown>[],
}));

vi.mock('../src/commands/models.ts', async (importOriginal) => {
  const listing = (form: string) => async (_shell: unknown, options: Record<string, unknown>) => {
    seen.models.push({ form, ...options });
    return 0;
  };
  return {
    ...(await importOriginal<typeof import('../src/commands/models.ts')>()),
    modelsShellOf: () => ({}),
    listModels: listing('list'),
    checkModels: listing('check'),
    detectModels: listing('detect'),
    runModelsForm: async (_shell: unknown, form: string, input: Record<string, unknown>) => {
      seen.models.push({ form, ...input });
      return 0;
    },
  };
});

vi.mock('../src/commands/evaluate.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/evaluate.ts')>()),
  evaluateContext: async (_ports: unknown, _dataset: unknown, options: Record<string, unknown>) => {
    seen.evaluateContext.push(options);
    return 0;
  },
}));

vi.mock('../src/commands/auto-mode.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/auto-mode.ts')>()),
  autoModeCheckPortsOf: async () => ({}),
  autoModeCheck: async (_ports: unknown, options: Record<string, unknown>) => {
    seen.autoModeCheck.push(options);
    return { measurement: 'passed' };
  },
}));

vi.mock('../src/commands/context.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/context.ts')>()),
  contextImprove: async (_ports: unknown, _paths: unknown, options: Record<string, unknown>) => {
    seen.contextImprove.push(options);
    return 0;
  },
}));

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
  const sink = { write: (text: string) => void out.push(text) };
  const ports = { version: '9.9.9', interrupt: new AbortController().signal, home: freshHome(), env: {}, cwd: '/c', terminal: {}, stdout: sink, stderr: sink, stdin: { isTerminal: true, bytes: async function* () {} } } as unknown as CliPorts;
  const program = buildProgram({
    ports,
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  const overrideExit = (command: typeof program): void => {
    command.exitOverride();
    command.commands.forEach(overrideExit);
  };
  overrideExit(program);
  program.configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => out.push(text) });
  return { program, out };
};

const run = (program: ReturnType<typeof harness>['program'], ...args: string[]): Promise<unknown> => program.parseAsync(args, { from: 'user' });

const MODEL_HELP = 'the model of the session, for example devstral-small-2 (momonga models lists them; /model switches it in an interactive session)';

const flat = (text: string): string => text.replace(/\s+/g, ' ');

const helpOf = async (...args: string[]): Promise<string> => {
  const { program, out } = harness();
  await run(program, ...args, '--help').catch(() => undefined);
  return flat(out.join(''));
};

describe('--model <model>', () => {
  it('names the model of a headless and of an interactive session as the text typed, and of the commands that run sessions', async () => {
    for (const calls of Object.values(seen)) calls.length = 0;

    await run(harness().program, '-p', 'hello', '--model', 'devstral-small-2');
    await run(harness().program, '--model', 'ollama/devstral-small-2');
    await run(harness().program, '-p', 'hello');
    await run(harness().program, 'eval', 'context', 'dataset.json', '--model', 'devstral-small-2');
    await run(harness().program, 'auto-mode', 'check', 'qwen3.8:27b', '--agent', 'devstral-small-2');
    await run(harness().program, 'context', 'improve', '--dataset', 'd.json', '--model', 'devstral-small-2', '--token-cap', '1000', '--outcome', 'o.json');

    expect(seen.headless[0]).toMatchObject({ prompt: 'hello', model: 'devstral-small-2' });
    expect(seen.interactive[0]).toMatchObject({ model: 'ollama/devstral-small-2' });
    expect(seen.headless[1]).not.toHaveProperty('model');
    expect(seen.evaluateContext[0]).toMatchObject({ model: 'devstral-small-2' });
    expect(seen.autoModeCheck[0]).toMatchObject({ classifier: 'qwen3.8:27b', agent: 'devstral-small-2' });
    expect(seen.contextImprove[0]).toMatchObject({ model: 'devstral-small-2' });
  });

  it('--alias is an unknown option, and --model needs a value', async () => {
    await expect(run(harness().program, 'eval', 'context', 'dataset.json', '--alias', 'x')).rejects.toMatchObject({ code: 'commander.unknownOption' });
    await expect(run(harness().program, 'context', 'improve', '--dataset', 'd.json', '--model', 'm', '--alias', 'x', '--token-cap', '1', '--outcome', 'o.json')).rejects.toMatchObject({ code: 'commander.unknownOption' });
    await expect(run(harness().program, '-p', 'hello', '--model')).rejects.toMatchObject({ code: 'commander.optionMissingArgument' });
  });

  it('the options of a momonga models form reach that form, and --json reaches the listing it follows', async () => {
    seen.models.length = 0;

    await run(harness().program, 'models', '--json');
    await run(harness().program, 'models', 'check', '--json');
    await run(harness().program, 'models', 'detect', 'http://127.0.0.1:8080', '--json');
    await run(harness().program, 'models', 'fallback', 'move', 'qwen3.8:27b', '--to', '1', '--yes');
    await run(harness().program, 'models', 'add-program', '--command', '/opt/bin/serve', '--arg', '--socket', '--arg', '{socket}', '--ready-path', '/health');

    expect(seen.models).toEqual([
      { form: 'list', json: true },
      { form: 'check', json: true },
      { form: 'detect', typed: ['http://127.0.0.1:8080'], json: true },
      { form: 'fallback move', args: ['qwen3.8:27b'], options: { to: '1', yes: true } },
      { form: 'add-program', args: [], options: { command: '/opt/bin/serve', arg: ['--socket', '{socket}'], readyPath: '/health' } },
    ]);
  });

  it('the help names a model, never an alias', async () => {
    const root = await helpOf();
    const evalContext = await helpOf('eval', 'context');
    const autoMode = await helpOf('auto-mode');
    const check = await helpOf('auto-mode', 'check');
    const improve = await helpOf('context', 'improve');
    const models = await helpOf('models');

    expect(root).toContain(`--model <model> ${MODEL_HELP}`);
    expect(evalContext).toContain('--model <model> the model every session of a live run uses');
    expect(check).toContain('check [options] [model]');
    expect(check).toContain('--agent <model> the model that drives the runs and proposes the calls the classifier judges');
    expect(autoMode).toContain('run the auto-mode dataset against a classifier model in temporary homes and store the measurement; with no model named it measures the configured classifier, else the agent model; auto mode stays selectable whatever it shows');
    expect(autoMode).toContain('show the stored measurement of a classifier model for this version; with no model named it shows the configured classifier, else the model new sessions start with');
    expect(improve).toContain('--model <model> the model of the benchmark sessions and of the analysis and candidate calls');
    expect(models).toContain('list the configured models with the capabilities they declare');
    expect([root, evalContext, autoMode, check, improve, models].join(' ')).not.toMatch(/alias/i);
  });
});
