import { describe, expect, it } from 'vitest';
import { LeaseLostError } from '@momonga/runtime';
import { JournalThreadError } from '@momonga/store';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';
import { envNeutralJson, firstConversation, firstRequestInput, settle } from './inheritance-support.ts';
import { builderOf, newFactsTrace, plantOldShapeChild, referenceFactsOf, tracedStore } from './inherit-reference-support.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

const answered = async (env: Env, task: string, answer: string): Promise<string> => {
  env.gateway.script.push(textStep(answer));
  const run = env.enqueue(task);
  expect((await settle(env, run.id)).status).toBe('COMPLETED');
  return run.id;
};

const inheritedEvents = (env: Env, runId: string) => env.events(runId).filter((event) => event.type === 'context.inherited');

const controlFirstInput = async (): Promise<string> => {
  const control = await makeEnv();
  await answered(control, 'Say hello', 'Hello there.');
  control.gateway.script.push(textStep('Answer.'));
  const run = control.enqueue('And again');
  await settle(control, run.id);
  return envNeutralJson(control, firstRequestInput(control, run.id));
};

const EXPECTED_CONVERSATION = [
  ['user', 'Say hello'],
  ['assistant', 'Hello there.'],
  ['user', 'And again'],
];

describe('13.6: crash between the commit of the reference and its use', () => {
  it('the next claim installs the window by a new read and builds the same first request, with one context.inherited', async () => {
    const expected = await controlFirstInput();
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello there.');
    let failed = false;
    const tools = {
      toolSet: async () => {
        if (!failed) {
          failed = true;
          throw new LeaseLostError();
        }
        return env.snapshotTools(env.toolbox.tools());
      },
    };
    env.gateway.script.push(textStep('Answer.'));
    const second = env.enqueue('And again');
    await env.runOnce(env.worker('worker-a', { tools }));
    expect(env.ofType(second.id, 'model.requested')).toEqual([]);
    expect(inheritedEvents(env, second.id)).toEqual([expect.objectContaining({ form: 'reference' })]);

    const trace = newFactsTrace();
    env.clock.advance(120_000);
    await env.runOnce(env.worker('worker-b', { tools, store: tracedStore(env.store, trace) }));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(trace.plans).toEqual([]);
    expect(trace.windows).toHaveLength(1);
    expect(inheritedEvents(env, second.id)).toHaveLength(1);
    expect(envNeutralJson(env, firstRequestInput(env, second.id))).toBe(expected);
  });
});

describe('13.6: crash during the read', () => {
  it('a thread failure during inherited_window writes nothing; the next claim reads again and finishes', async () => {
    const expected = await controlFirstInput();
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello there.');
    env.gateway.script.push(textStep('Answer.'));
    const second = env.enqueue('And again');
    const trace = newFactsTrace();
    const failing = tracedStore(env.store, trace, {
      window: (_request, call) => (call === 1 ? Promise.reject(new JournalThreadError('the journal thread died during inherited_window')) : undefined),
    });

    await env.runOnce(env.worker('worker-a', { store: failing }));
    const afterFailure = env.events(second.id);
    expect(afterFailure.filter((event) => event.type === 'model.requested')).toEqual([]);
    expect(afterFailure.filter((event) => event.type === 'context.inherited')).toEqual([expect.objectContaining({ form: 'reference' })]);
    expect(['QUEUED', 'RUNNING']).toContain(env.run(second.id).status);
    expect(trace.windows).toHaveLength(1);

    env.clock.advance(120_000);
    await settle(env, second.id, env.worker('worker-b', { store: failing }));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(trace.windows).toHaveLength(2);
    expect(trace.windows[1]).toEqual(trace.windows[0]);
    expect(inheritedEvents(env, second.id)).toHaveLength(1);
    expect(envNeutralJson(env, firstRequestInput(env, second.id))).toBe(expected);
  });
});

describe('13.6: crash during inherit_plan', () => {
  it('a thread failure during inherit_plan writes no reference; the next claim plans again and writes exactly one', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello there.');
    env.gateway.script.push(textStep('Answer.'));
    const second = env.enqueue('And again');
    const trace = newFactsTrace();
    const failing = tracedStore(env.store, trace, {
      plan: (_request, call) => (call === 1 ? Promise.reject(new JournalThreadError('the journal thread died during inherit_plan')) : undefined),
    });

    await env.runOnce(env.worker('worker-a', { store: failing }));
    expect(inheritedEvents(env, second.id)).toEqual([]);
    expect(env.ofType(second.id, 'model.requested')).toEqual([]);
    expect(trace.plans).toEqual([{ runId: second.id, mode: 'manual', unasked: UNASKED_COMMANDS }]);

    env.clock.advance(120_000);
    await settle(env, second.id, env.worker('worker-b', { store: failing }));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(trace.plans).toHaveLength(2);
    expect(inheritedEvents(env, second.id)).toEqual([expect.objectContaining({ form: 'reference' })]);
    expect(firstConversation(env, second.id)).toEqual(EXPECTED_CONVERSATION);
  });
});

describe('13.6: a resent thread request', () => {
  it('a duplicate inherited_window and a duplicate inherit_plan answer exactly as the first', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello there.');
    const b = builderOf(env);
    const queued = b.createRun('Not yet claimed');
    const facts = referenceFactsOf(env.store);
    const plan = await facts.inheritPlan({ runId: queued.id, mode: 'manual', unasked: UNASKED_COMMANDS });
    expect(plan).toMatchObject({ kind: 'ready', payload: { form: 'reference' } });
    expect(await facts.inheritPlan({ runId: queued.id, mode: 'manual', unasked: UNASKED_COMMANDS })).toEqual(plan);
    expect(inheritedEvents(env, queued.id)).toEqual([]);

    env.gateway.script.push(textStep('Answer.'));
    await settle(env, queued.id);
    const request = { runId: queued.id, windowTokens: 100_000, floorTokens: 1 };
    const window = await facts.inheritedWindow(request);
    expect(window.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(await facts.inheritedWindow(request)).toEqual(window);
  });
});

describe('13.6: a run with an old-shape event resumes on today path', () => {
  it('folds the copy and makes no window request', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello there.');
    const child = await plantOldShapeChild(env, 'And again');
    env.gateway.script.push(textStep('Answer.'));
    const trace = newFactsTrace();
    await settle(env, child.id, env.worker('worker-1', { store: tracedStore(env.store, trace) }));
    expect(env.run(child.id).status).toBe('COMPLETED');
    expect(trace.windows).toEqual([]);
    expect(trace.plans).toEqual([]);
    expect(firstConversation(env, child.id)).toEqual(EXPECTED_CONVERSATION);
  });
});

describe('13.6: two claimants', () => {
  it('a second inheritContext for the same claim answers already and appends nothing', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello there.');
    const b = builderOf(env);
    const child = b.createRun('And again');
    const claim = b.claimNext(child.id);
    expect(await env.store.inheritContext(claim, { mode: 'manual' })).toEqual({ kind: 'inherited' });
    expect(await env.store.inheritContext(claim, { mode: 'manual' })).toEqual({ kind: 'already' });
    expect(inheritedEvents(env, child.id)).toEqual([expect.objectContaining({ form: 'reference' })]);
  });
});
