import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const RETRY_GAP_MS = 60_000;
const MAX_CLAIMS = 8;
const CLEAN = 'GOAL:\ng\nSTATE:\ns\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [assistantMessage(`m${step}`, text)], usage: USAGE },
});

const conversation = (): RunEventPayload[] => [
  responded(1, `long ${'x'.repeat(120_000)}`),
  { type: 'user.message', text: 'question two' },
  responded(2, 'answer two'),
  { type: 'user.message', text: 'question three' },
  responded(3, 'answer three'),
  { type: 'user.message', text: 'question four' },
];

const prepared = async (roles: Record<string, string> = {}) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  env.settings.rolesValue = { ...roles };
  const run = env.enqueue('question one');
  env.seed(run.id, conversation(), 'release');
  env.gateway.compactSummaries.push(CLEAN);
  env.gateway.script.push(textStep('Done.'));
  return { env, run };
};

const drive = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !['COMPLETED', 'FAILED', 'STOPPED'].includes(env.run(runId).status); claim += 1) {
    await env.runOnce(env.worker());
    env.clock.advance(RETRY_GAP_MS);
  }
};

const changingOutage = (env: Env, change: () => void): void => {
  let outages = 0;
  env.gateway.compactHook = async () => {
    outages += 1;
    if (outages > 1) return;
    change();
    throw new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' });
  };
};


const SCRIPT_TARGET = { fm: { adapter: 'chat-completions', model: 'fake-model', answers: 'script' as const } };

const withTargets = async (targets: Record<string, { adapter: string; model: string; answers?: 'model' | 'script' }>) => {
  const { env, run } = await prepared();
  env.settings.targetsValue = targets;
  return { env, run };
};

describe('the pinned provenance of the targets', () => {
  it('run.started records the adapter, the upstream model and what answers of every configured target', async () => {
    const { env, run } = await withTargets({ ...SCRIPT_TARGET, undeclared: { adapter: 'ollama', model: 'llama3' } });
    await drive(env, run.id);
    const starts = env.ofType(run.id, 'run.started');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    for (const start of starts) {
      expect(start.pins['targets']).toEqual({
        fm: { adapter: 'chat-completions', model: 'fake-model', answers: 'script' },
        undeclared: { adapter: 'ollama', model: 'llama3' },
      });
    }
  });

  it('a recovered run keeps the pinned value: a settings change between claims does not reach run.started', async () => {
    const { env, run } = await withTargets(SCRIPT_TARGET);
    changingOutage(env, () => {
      env.settings.targetsValue = { fm: { adapter: 'chat-completions', model: 'fake-model', answers: 'model' } };
    });
    await drive(env, run.id);
    expect(env.run(run.id).status).toBe('COMPLETED');
    const starts = env.ofType(run.id, 'run.started');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const start of starts) expect(start.pins['targets']).toEqual({ fm: { adapter: 'chat-completions', model: 'fake-model', answers: 'script' } });
  });

  it('a run that starts after the change takes the new value', async () => {
    const { env, run } = await withTargets(SCRIPT_TARGET);
    await drive(env, run.id);
    env.settings.targetsValue = { fm: { adapter: 'chat-completions', model: 'fake-model', answers: 'model' } };
    env.gateway.script.push(textStep('Second.'));
    const second = env.enqueue('Second task');
    await drive(env, second.id);
    expect(env.ofType(second.id, 'run.started')[0]?.pins['targets']).toEqual({ fm: { adapter: 'chat-completions', model: 'fake-model', answers: 'model' } });
  });
});
