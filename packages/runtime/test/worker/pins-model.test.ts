import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '@momonga/runtime';
import type { RunEventPayload } from '@momonga/protocol';
import { DEADLINE_MS, capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const WINDOW = 40_000;
const MAX_CLAIMS = 8;
const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const RETRY_GAP_MS = 60_000;
const CLEAN = 'GOAL:\ng\nSTATE:\ns\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';
const FIRST = 'ollama/devstral-small-2:latest';
const SECOND = 'lmstudio/gemma-3-4b';
const CHEAP = 'ollama/qwen3.8:27b';

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { id: `resp_${step}`, status: 'completed', output: [{ type: 'message', id: `msg_${step}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: USAGE },
});

const conversation = (): RunEventPayload[] => [
  responded(1, `long ${'x'.repeat(120_000)}`),
  { type: 'user.message', text: 'question two' },
  responded(2, 'answer two'),
  { type: 'user.message', text: 'question three' },
  responded(3, 'answer three'),
  { type: 'user.message', text: 'question four' },
];

const drive = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !['COMPLETED', 'FAILED', 'STOPPED'].includes(env.run(runId).status); claim += 1) {
    await env.runOnce(env.worker());
    env.clock.advance(RETRY_GAP_MS);
  }
};

const onListedModels = async () => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  env.setModel(FIRST);
  env.gateway.chainsByModel[FIRST] = [FIRST, SECOND];
  env.gateway.memberFacts = {
    [FIRST]: { adapter: 'ollama', upstream: 'devstral-small-2:latest', answers: 'model' },
    [SECOND]: { adapter: 'chat-completions', upstream: 'gemma-3-4b', answers: 'model' },
  };
  env.gateway.roles = { compaction: CHEAP };
  return env;
};

describe('what a run pins about its model (design-model-names 3.4, 3.10, 3.11, 1.8 A11)', () => {
  it('pins the model of the session and the roles of the listing as full references', async () => {
    const env = await onListedModels();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    await drive(env, run.id);
    const [started] = env.ofType(run.id, 'run.started');
    expect(started?.pins['model']).toBe(FIRST);
    expect(started?.pins['roles']).toEqual({ compaction: CHEAP });
    expect(started?.pins).not.toHaveProperty('modelAlias');
  });

  it('pins each member of the chain the gateway lists under its full reference, with its adapter, its own name and what answers', async () => {
    const env = await onListedModels();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    await drive(env, run.id);
    expect(env.ofType(run.id, 'run.started')[0]?.pins['targets']).toEqual({
      [FIRST]: { adapter: 'ollama', model: 'devstral-small-2:latest', answers: 'model' },
      [SECOND]: { adapter: 'chat-completions', model: 'gemma-3-4b', answers: 'model' },
    });
  });

  it('keeps the pinned model, roles and chain members of a running run when the start model, the fallback order and the entry change between its claims', async () => {
    const env = await onListedModels();
    const run = env.enqueue('question one');
    await env.seed(run.id, conversation(), 'release');
    env.gateway.compactSummaries.push(CLEAN);
    env.gateway.script.push(textStep('Done.'));
    let outages = 0;
    env.gateway.compactHook = async () => {
      outages += 1;
      if (outages > 1) return;
      env.gateway.start = SECOND;
      env.gateway.chainsByModel[FIRST] = [FIRST];
      env.gateway.memberFacts = { [FIRST]: { adapter: 'chat-completions', upstream: 'renamed', answers: 'script' } };
      env.gateway.roles = { compaction: SECOND };
      throw new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' });
    };
    await drive(env, run.id);
    expect(env.run(run.id).status).toBe('COMPLETED');
    const starts = env.ofType(run.id, 'run.started');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const start of starts) {
      expect(start.pins['model']).toBe(FIRST);
      expect(start.pins['roles']).toEqual({ compaction: CHEAP });
      expect(start.pins['targets']).toEqual(starts[0]?.pins['targets']);
    }
    expect(env.gateway.compacts.map((compact) => compact.request.model)).toEqual([CHEAP, CHEAP]);
  });

  it('fails a run whose role no longer names a configured model when it is claimed, and falls back to no other model', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const created = env.store.createRunAndEnqueue(env.session.id, { input: 'Parent', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' });
    if (created.kind !== 'created') throw new Error(`the parent run was not created: ${created.kind}`);
    const claim = await env.seed(created.run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: env.session.model, roles: { compaction: 'x' } }, mode: 'default' }], 'hold');
    const child = env.store.createChildRun({ parentRunId: created.run.id, parentCallId: 'call_child', input: 'Child', pins: {}, model: env.session.model });
    if (child.kind !== 'created') throw new Error(`the child run was not created: ${child.kind}`);
    expect((await env.store.releaseLease(claim, { availableAt: env.clock.now() + 3_600_000 })).kind).toBe('ok');
    env.gateway.script.push(textStep('Child done.'));
    await drive(env, child.run.id);
    expect(env.run(child.run.id).status).toBe('FAILED');
    expect(env.run(child.run.id).error).toEqual({ code: 'model_not_found', message: 'The model for summaries ("x") is not configured any more. Choose another with /models role.' });
    expect(env.gateway.streams).toEqual([]);
    expect(env.ofType(child.run.id, 'run.started')).toEqual([]);
  });
});
