import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { ChainCapabilities, NeedsProbe, ToolCallingState } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { EXIT_FAILURE } from '@momonga/foundation';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { frameOf } from './acp-harness.ts';
import { SESSION, capabilitiesOf, runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const log: string[] = [];

const fakeClient = {
  skills: async () => ({ skills: [], warnings: [] }),
  createRun: async () => {
    log.push('createRun');
    return { run: runView({ id: 'run-1', status: 'QUEUED' }) };
  },
  streamEvents: async function* () {
    yield frameOf('run-1', 1, { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'A plain answer.' });
  },
  getRun: async () => runView({ id: 'run-1', status: 'COMPLETED' }),
  childRuns: async () => [],
  cancel: async () => ({ status: 202, run: runView({ status: 'CANCELLED' }) }),
  close: async () => undefined,
} as unknown as RuntimeClient;

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async () => {
    log.push('openSession');
    return { client: fakeClient, created: { session: SESSION, strippedEnvKeys: [] }, close: async () => undefined };
  },
}));

const NO_TOOLS_NOTICE = 'This model cannot call tools';

const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'target local has not been probed for tool calling',
  evidence: 'no probe record for local',
  remedy: 'run the tool-calling probe for local',
};

const headless = (context: Parameters<typeof withTempDir>[0], toolCalling: ToolCallingState) =>
  headlessReading(context, { ...capabilitiesOf(), toolCalling }, 'text');

const headlessReading = async (context: Parameters<typeof withTempDir>[0], capabilities: unknown, format: HeadlessOptions['format']) => {
  log.length = 0;
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  await ensureMomongaDirs(paths);
  const stderr: string[] = [];
  const stdout: string[] = [];
  const ports = {
    version: '1.0.0',
    env: { PATH: '/usr/bin' },
    home,
    cwd: home,
    clock: virtualClock(),
    random: () => 0.5,
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: {
      write: (text: string) => {
        log.push(`stderr:${text}`);
        stderr.push(text);
      },
    },
  } as unknown as CliPorts;
  const capabilitiesOfModel = async (model: string): Promise<ChainCapabilities> => {
    log.push(`capabilitiesOf:${model}`);
    return capabilities as ChainCapabilities;
  };
  const options = { prompt: 'explain the module', format, verbose: false, interrupt: new AbortController().signal, capabilitiesOf: capabilitiesOfModel, modelList: async () => ({ data: [], start: null }) } as HeadlessOptions;
  const code = await runHeadless(ports, paths, options);
  return { code, stderr: stderr.join(''), stdout: stdout.join('') };
};

describe('headless asks capabilitiesOf(model) at session open and shows the verdict before any request (design R1, second moment)', () => {
  it('shows the no-tools notice once on stderr before the run is created, and the run proceeds', async (context) => {
    const result = await headless(context, 'none');

    expect(result.stderr.split(NO_TOOLS_NOTICE).length - 1).toBe(1);
    const noticeAt = log.findIndex((entry) => entry.startsWith('stderr:') && entry.includes(NO_TOOLS_NOTICE));
    expect(log).toContain(`capabilitiesOf:${SESSION.model}`);
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(log.indexOf('createRun'));
    expect(result.stderr).toContain('momonga --model <model>');
    expect(result.stderr).not.toContain('/model');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('A plain answer.');
  });

  it('ends an unprobed model with the refusal and its remedy and creates no run', async (context) => {
    const result = await headless(context, NEEDS_PROBE);

    expect(result.code).not.toBe(0);
    expect(log).toContain(`capabilitiesOf:${SESSION.model}`);
    expect(log).not.toContain('createRun');
    expect(result.stderr).toContain(NEEDS_PROBE.remedy);
    expect(result.stderr).not.toContain('target_not_ready');
  });

  it('leaves the measuring line to the run, which shows it once per measuring state, and the run proceeds', async (context) => {
    const result = await headless(context, { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } });

    expect(log.slice(0, log.indexOf('createRun')).filter((entry) => entry.startsWith('stderr:') && entry.includes('measuring toolCalling of this model'))).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('A plain answer.');
  });
});

const UNAVAILABLE_MESSAGE =
  'the model plan-model cannot be used yet: the settings give no context window and output limit for it, and the model list of its account reports none; momonga models --catalog reads the list';
const UNAVAILABLE_REMEDY = 'Choose a model with momonga --model <model>, or set one up with momonga models add.';
const UNAVAILABLE = {
  toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNAVAILABLE_MESSAGE, param: 'model' },
  source: 'unprobed',
};

describe('headless refuses a model the gateway lists as unavailable before the run is created (G1)', () => {
  it('an unavailable model is refused before the run is created', async (context) => {
    const result = await headlessReading(context, UNAVAILABLE, 'text');

    expect(log).not.toContain('createRun');
    expect(result.stderr).toBe(`momonga: ${UNAVAILABLE_MESSAGE}\n${UNAVAILABLE_REMEDY}\n`);
    expect(result.stdout).toBe('');
    expect(result.code).toBe(EXIT_FAILURE);
  });

  it('the refused JSON object is printed in json format', async (context) => {
    const result = await headlessReading(context, UNAVAILABLE, 'json');

    expect(log).not.toContain('createRun');
    expect(result.stdout).toBe(
      `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '', error: { code: 'target_not_ready', message: `${UNAVAILABLE_MESSAGE}\n${UNAVAILABLE_REMEDY}` } })}\n`,
    );
    expect(result.code).toBe(EXIT_FAILURE);
  });
});
