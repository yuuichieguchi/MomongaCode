import { EXIT_OK, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import type { ReasoningCapability, ReasoningEffort } from '@momonga/protocol';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { frameOf } from './acp-harness.ts';
import { SESSION, capabilitiesOf, runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const typed = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

const fakeClient = {
  skills: async () => ({ skills: [], warnings: [] }),
  createRun: async () => ({ run: runView({ id: 'run-1', status: 'QUEUED' }) }),
  streamEvents: async function* () {
    yield frameOf('run-1', 1, { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'A plain answer.' });
  },
  getRun: async () => runView({ id: 'run-1', status: 'COMPLETED' }),
  childRuns: async () => [],
  cancel: async () => ({ status: 202, run: runView({ status: 'CANCELLED' }) }),
  close: async () => undefined,
} as unknown as RuntimeClient;

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async (_ports: unknown, _paths: unknown, options: Record<string, unknown>) => {
    typed.options.push(options);
    return { client: fakeClient, created: { session: SESSION, strippedEnvKeys: [] }, close: async () => undefined };
  },
}));

const headlessWith = async (context: TestContext, effort: ReasoningEffort, reasoning: ReasoningCapability | undefined): Promise<string[]> => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  await ensureMomongaDirs(paths);
  const stderr: string[] = [];
  const ports = {
    version: '1.0.0',
    env: { PATH: '/usr/bin' },
    home,
    cwd: home,
    clock: virtualClock(),
    random: () => 0.5,
    stdout: { write: () => true },
    stderr: { write: (text: string) => stderr.push(text) },
  } as unknown as CliPorts;
  const options = {
    prompt: async () => 'explain the module',
    format: 'text',
    verbose: false,
    effort,
    interrupt: new AbortController().signal,
    capabilitiesOf: async () => ({ ...capabilitiesOf(), ...(reasoning === undefined ? {} : { reasoning }) }),
    modelList: async () => ({ data: [], start: null }),
  } as unknown as HeadlessOptions;
  expect(await runHeadless(ports, paths, options)).toBe(EXIT_OK);
  return stderr.join('').split('\n');
};

describe('momonga -p --effort', () => {
  it('opens the session with the level of the command line', async (context) => {
    await headlessWith(context, 'high', { control: 'reasoning_effort', lowest: 'low' });
    expect(typed.options.at(-1)).toMatchObject({ effort: 'high' });
  });

  it('says once on stderr that a level the model does not accept is moved to the one it accepts', async (context) => {
    const lines = await headlessWith(context, 'minimal', { control: 'reasoning_effort', lowest: 'low' });
    expect(lines.filter((line) => line.includes('was chosen'))).toEqual([`momonga: effort minimal was chosen; ${SESSION.model} does not accept it, so low is used`]);
  });

  it('says on stderr that no effort is sent to a model without a reasoning control', async (context) => {
    const lines = await headlessWith(context, 'high', undefined);
    expect(lines.filter((line) => line.includes('was chosen'))).toEqual([`momonga: effort high was chosen, but ${SESSION.model} declares no reasoning effort, so none is sent`]);
  });

  it('says nothing when the level is sent as chosen', async (context) => {
    const lines = await headlessWith(context, 'high', { control: 'reasoning_effort', lowest: 'low' });
    expect(lines.filter((line) => line.includes('was chosen'))).toEqual([]);
  });
});
