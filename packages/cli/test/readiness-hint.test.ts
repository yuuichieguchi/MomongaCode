import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { agentReadiness, messageOf, readinessRemedy } from '@momonga/protocol';
import type { MomongaModelEntry } from '@momonga/protocol';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import { RunApiError } from '../src/client/runtime-client.ts';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { readinessNoticeOf } from '../src/readiness.ts';
import { EXIT_FAILURE } from '@momonga/foundation';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { frameOf } from './acp-harness.ts';
import { SESSION, capabilitiesOf, runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const opening = vi.hoisted(() => ({ refusal: undefined as Error | undefined }));

const fakeClient = {
  skills: async () => ({ skills: [], warnings: [] }),
  createRun: async () => ({ run: runView({ id: 'run-1', status: 'QUEUED' }) }),
  streamEvents: async function* () {
    yield frameOf('run-1', 1, { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'A plain answer.' });
  },
  getRun: async () => runView({ id: 'run-1', status: 'COMPLETED' }),
  childRuns: async () => [],
  close: async () => undefined,
} as unknown as RuntimeClient;

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async () => {
    if (opening.refusal !== undefined) throw opening.refusal;
    return { client: fakeClient, created: { session: SESSION, strippedEnvKeys: [] }, close: async () => undefined };
  },
}));

const UNAVAILABLE_MESSAGE = 'the model plan-model cannot be used yet';

const UNAVAILABLE = {
  toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNAVAILABLE_MESSAGE, param: 'model' },
  source: 'unprobed',
} as const;

const headless = async (context: Parameters<typeof withTempDir>[0], capabilities: MomongaModelEntry['capabilities']) => {
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
    stderr: { write: (text: string) => stderr.push(text) },
  } as unknown as CliPorts;
  const options = { prompt: 'explain the module', format: 'text', verbose: false, interrupt: new AbortController().signal, capabilitiesOf: async () => capabilities, modelList: async () => ({ data: [], start: null }) } as HeadlessOptions;
  const code = await runHeadless(ports, paths, options);
  return { code, stderr: stderr.join(''), stdout: stdout.join(''), paths };
};

describe('what a shell surface says when no model can answer', () => {
  it('headless prints the shell text of no model connected and exits with failure when the runtime refuses the session for want of a model', async (context) => {
    const message = messageOf('noModelConnected', 'cli');
    opening.refusal = new RunApiError('POST /v1/sessions', 409, JSON.stringify({ error: { type: 'conflict', code: 'target_not_ready', message } }));
    try {
      const result = await headless(context, capabilitiesOf());

      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toBe(`momonga: ${message}\n`);
    } finally {
      opening.refusal = undefined;
    }
  });

  it('headless prints the sentence of the runtime for a --model that is not configured and exits with failure', async (context) => {
    const sentence = 'The model "nope" is not configured. Configured models: devstral-small-2.';
    opening.refusal = new RunApiError('POST /v1/sessions', 400, JSON.stringify({ error: { type: 'invalid_request', code: 'invalid_request', message: sentence, param: 'model' } }));
    try {
      const result = await headless(context, capabilitiesOf());

      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toBe(`momonga: ${sentence}\n`);
    } finally {
      opening.refusal = undefined;
    }
  });

  it('headless on a model that cannot call tools writes the warning with the message and then the shell remedy', async (context) => {
    const readiness = agentReadiness({ toolCalling: 'none' });

    const result = await headless(context, { ...capabilitiesOf(), toolCalling: 'none' });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`momonga: warning: ${readiness.state === 'ready' ? '' : readiness.message}\nFor coding work, choose another model with momonga --model <model>; momonga models detect lists the local servers that are running.\n`);
  });

  it('headless on an unavailable model refuses with the message and then the shell remedy', async (context) => {
    const result = await headless(context, UNAVAILABLE);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(`momonga: ${UNAVAILABLE_MESSAGE}\nChoose a model with momonga --model <model>, or set one up with momonga models add.\n`);
  });

  it('the notice of the terminal UI ends with the remedy that names slash commands', () => {
    expect(readinessNoticeOf(agentReadiness({ toolCalling: 'none' }), 'tui')?.endsWith(readinessRemedy('no_tools', 'tui'))).toBe(true);
    expect(readinessRemedy('no_tools', 'tui')).toBe('For coding work, choose another model with /model; /models add lists the local servers that are running.');
  });
});
