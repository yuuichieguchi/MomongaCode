import { describe, expect, it, vi } from 'vitest';
import * as contextModule from '@momonga/context';
import { inputCeilingFor } from '@momonga/context';
import type { Capabilities, RunEventPayload } from '@momonga/protocol';
import { summaryInputCeilingFor } from '../../../context/src/budget.ts';
import { omittedMarker } from '../../../context/src/tool-output.ts';
import { generatedRun } from '../../../store/test/support/reference.ts';
import { seeded } from '../../../store/test/support/seeded.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { envNeutralJson, requestInputs, settle } from './inheritance-support.ts';
import { builderOf, harnessOf, newFactsTrace, plantOldShapeChild, tracedStore } from './inherit-reference-support.ts';
import type { FactsTrace } from './inherit-reference-support.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

type Shape = 'copy' | 'reference';

type WindowBound = { windowTokens: number; floorTokens: number };

const inheritanceWindowFor = (targets: readonly Capabilities[]): WindowBound => {
  const found = (contextModule as Record<string, unknown>)['inheritanceWindowFor'];
  if (typeof found !== 'function') throw new Error('@momonga/context exports no inheritanceWindowFor');
  return (found as (targets: readonly Capabilities[]) => WindowBound)(targets);
};

const noticesOf = (env: Env, runId: string): string[] => env.ofType(runId, 'notice').map((event) => event.message);

const runNeutral = (env: Env, sessionId: string, text: string): string =>
  env.store.listRuns(sessionId).reduce((neutral, run, ordinal) => neutral.split(run.id).join(`<run-${ordinal}>`), text);

const withoutEvictedCount = (notice: string): string => notice.replace(/\d+ tool outputs were replaced by handles/, 'N tool outputs were replaced by handles');

const evictedCountOf = (notice: string): number => Number(/(\d+) tool outputs were replaced by handles/.exec(notice)?.[1] ?? Number.NaN);

const outcomeOf = (env: Env, runId: string) => {
  const run = env.run(runId);
  return { status: run.status, stopReason: run.stopReason, errorCode: run.error?.code };
};

type Case = { seed: number; window: number; autoCompact: boolean; heavyRuns: number };

const runCase = async ({ seed, window, autoCompact, heavyRuns }: Case, shape: Shape) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(window) });
  env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact };
  const random = seeded(seed);
  const h = harnessOf(env);
  const b = builderOf(env);
  const length = random.pick([1, 2, 3, 10] as const);
  for (let index = 0; index < length; index += 1) {
    await generatedRun(h, b, random, index, { fresh: index === 0, oldShape: shape === 'copy' && index > 0, recordTokens: false });
  }
  for (let heavy = 0; heavy < heavyRuns; heavy += 1) {
    const run = b.createRun(`heavy ${heavy}`);
    const claim = b.claimNext(run.id);
    if (shape === 'copy') b.inheritOldShape(claim, 'default');
    else await b.inherit(claim, 'default');
    b.started(claim, 'default');
    for (let step = 0; step < 6; step += 1) {
      b.text(claim, 6_000);
      b.tool(claim, { outputChars: 1_500, evict: step % 3 === 0, withTokens: false });
    }
    await b.end(claim, { to: 'COMPLETED' });
  }
  const trace: FactsTrace = newFactsTrace();
  const child = shape === 'copy' ? await plantOldShapeChild(env, 'the child task') : b.createRun('the child task');
  env.gateway.script.push(textStep('Done.'), textStep('Done again.'));
  const store = shape === 'reference' ? tracedStore(env.store, trace) : env.store;
  await settle(env, child.id, env.worker('worker-1', { store }));
  return {
    env,
    trace,
    outcome: outcomeOf(env, child.id),
    requests: requestInputs(env, child.id).map((input) => runNeutral(env, child.sessionId, envNeutralJson(env, input))),
    notices: noticesOf(env, child.id).map((notice) => runNeutral(env, child.sessionId, notice)),
  };
};

const CASES: Case[] = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) => [
  { seed, window: 100_000, autoCompact: true, heavyRuns: 0 },
  { seed, window: 8_000, autoCompact: true, heavyRuns: seed % 4 },
  { seed, window: 8_000, autoCompact: false, heavyRuns: seed % 4 },
  ...(seed <= 2 ? [{ seed, window: 8_000, autoCompact: false, heavyRuns: 6 }, { seed, window: 8_000, autoCompact: true, heavyRuns: 6 }] : []),
]);

describe('R2 and R15 through the worker: old and new give the same request for the same journal (13.7 points 1 and 2)', () => {
  it('builds byte-equal requests, or overflows the same way, over seeded journals and capability sets', async () => {
    let omitted = 0;
    for (const testCase of CASES) {
      const label = `seed ${testCase.seed} window ${testCase.window} autoCompact ${testCase.autoCompact}`;
      const copy = await runCase(testCase, 'copy');
      const reference = await runCase(testCase, 'reference');
      expect(reference.trace.windows.length, label).toBeGreaterThan(0);
      expect(reference.outcome, label).toEqual(copy.outcome);
      expect(reference.requests, label).toEqual(copy.requests);
      const omittedOlder = reference.trace.windowReplies.some((reply) => reply.omittedOlder);
      if (omittedOlder) {
        omitted += 1;
        expect(copy.outcome, `${label}: R15, a window that omitted older items means today's build overflows`).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
        expect(reference.notices.some((notice) => /lower bound/i.test(notice)), label).toBe(true);
      } else {
        expect(reference.notices.map(withoutEvictedCount), label).toEqual(copy.notices.map(withoutEvictedCount));
        reference.notices.forEach((notice, index) => {
          const counted = evictedCountOf(notice);
          if (Number.isNaN(counted)) return;
          expect(counted, `${label}: 13.7 3(d), the delivered set never holds more ids than the copy`).toBeLessThanOrEqual(evictedCountOf(copy.notices[index] as string));
        });
      }
    }
    expect(omitted).toBeGreaterThan(0);
  });
});

describe('the window request carries W = C + S over the claim targets and the marker floor (13.4)', () => {
  it('inheritanceWindowFor is the input ceiling plus the summary input ceiling, maximised over targets', async () => {
    const small = capabilitiesFor(8_000);
    const large = capabilitiesFor(200_000);
    expect(inheritanceWindowFor([small]).windowTokens).toBe(inputCeilingFor(small) + summaryInputCeilingFor(small));
    expect(inheritanceWindowFor([small, large]).windowTokens).toBe(inputCeilingFor(large) + summaryInputCeilingFor(large));
    const floor = inheritanceWindowFor([small]).floorTokens;
    expect(Number.isInteger(floor)).toBe(true);
    expect(floor).toBeGreaterThanOrEqual(1);
    expect(floor).toBeLessThanOrEqual(Math.ceil(omittedMarker(0, '', undefined).length / 4));
  });

  it('the claim asks the thread with the numbers derived from its own capabilities', async () => {
    const capabilities = capabilitiesFor(30_000);
    const env = await makeEnv({ capabilities });
    const b = builderOf(env);
    const first = b.createRun('Say hello', { history: 'fresh' });
    env.gateway.script.push(textStep('Hello.'));
    await settle(env, first.id);
    const child = b.createRun('And again');
    env.gateway.script.push(textStep('Again.'));
    const trace = newFactsTrace();
    await settle(env, child.id, env.worker('worker-1', { store: tracedStore(env.store, trace) }));
    expect(trace.windows).toEqual([{ runId: child.id, ...inheritanceWindowFor([capabilities]) }]);
  });
});

describe('known differences of 13.7, pinned as stated', () => {
  it('(a) the stop notice says its numbers are lower bounds when older inherited items were not read', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(5_000) });
    env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact: false };
    const b = builderOf(env);
    const first = b.createRun('Big history', { history: 'fresh' });
    const claim = b.claimNext(first.id);
    b.started(claim, 'default');
    for (let step = 0; step < 30; step += 1) b.text(claim, 2_000);
    await b.end(claim, { to: 'COMPLETED' });
    const child = b.createRun('Next');
    const trace = newFactsTrace();
    await settle(env, child.id, env.worker('worker-1', { store: tracedStore(env.store, trace) }));
    expect(trace.windowReplies.at(-1)?.omittedOlder).toBe(true);
    expect(env.run(child.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(noticesOf(env, child.id).filter((notice) => /lower bound/i.test(notice))).toHaveLength(1);
  });

  it('(b) a dangling output beyond the window is not reported at inheritance', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(5_000) });
    env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact: false };
    const b = builderOf(env);
    const first = b.createRun('Corrupt early', { history: 'fresh' });
    const claim = b.claimNext(first.id);
    b.started(claim, 'default');
    const callId = b.tool(claim);
    for (let step = 0; step < 30; step += 1) b.text(claim, 2_000);
    await b.end(claim, { to: 'COMPLETED' });
    const db = env.raw();
    db.exec('DROP TRIGGER IF EXISTS events_reject_update');
    db.prepare(
      `UPDATE events SET payload_json = json_set(payload_json, '$.response.output[0]', json('{"type":"message","id":"m-x","role":"assistant","status":"completed","content":[{"type":"output_text","text":"no call","annotations":[]}]}')) WHERE run_id = ? AND type = 'model.responded' AND json_extract(payload_json, '$.response.output[0].call_id') = ?`,
    ).run(first.id, callId);
    const child = b.createRun('Next');
    const trace = newFactsTrace();
    await settle(env, child.id, env.worker('worker-1', { store: tracedStore(env.store, trace) }));
    expect(trace.windowReplies.at(-1)?.omittedOlder).toBe(true);
    expect(env.run(child.id).error?.code).not.toBe('previous_run_inconsistent');
    expect(env.run(child.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
  });

  it('(c) and (d) a call id evicted and then compacted away is not known: today it fails as call_id_reused, the reference does not', async () => {
    const outcomeFor = async (shape: Shape) => {
      const env = await makeEnv();
      env.gateway.rewriteCallIds = false;
      const b = builderOf(env);
      const first = b.createRun('Write it', { history: 'fresh' });
      const claim = b.claimNext(first.id);
      b.started(claim, 'default');
      const callId = b.tool(claim, { evict: true, withTokens: false });
      b.text(claim);
      b.compact(claim, 3);
      b.text(claim);
      await b.end(claim, { to: 'COMPLETED' });
      const child = shape === 'copy' ? await plantOldShapeChild(env, 'Again') : b.createRun('Again');
      env.gateway.script.push(callsStep([{ callId, name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
      await settle(env, child.id);
      return { run: env.run(child.id), state: env.fold(child.id) };
    };
    const copy = await outcomeFor('copy');
    expect(copy.run).toMatchObject({ status: 'FAILED', error: { code: 'call_id_reused' } });
    const reference = await outcomeFor('reference');
    expect(reference.run.status).toBe('COMPLETED');
    expect(reference.run.error?.code).toBeUndefined();
  });
});

describe('D2: context.truncated records the output token count', () => {
  it('an eviction written by the worker carries tokens, a positive integer of the evicted output size', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact: false };
    const run = env.enqueue('question one');
    const usage = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
    const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage } }) as RunEventPayload;
    await env.seed(
      run.id,
      [
        responded(1, [{ type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/proj/big.txt"}' }]),
        { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'other', title: 'Read', rawInput: { file_path: '/proj/big.txt' } },
        { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'r'.repeat(60_000), handle: 'f'.repeat(64) },
        responded(2, [{ type: 'message', id: 'm2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `long ${'x'.repeat(60_000)}`, annotations: [] }] }]),
        { type: 'user.message', text: 'question two' },
        responded(3, [{ type: 'message', id: 'm3', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer two ${'y'.repeat(60_000)}`, annotations: [] }] }]),
        { type: 'user.message', text: 'question three' },
        responded(4, [{ type: 'message', id: 'm4', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer three ${'z'.repeat(60_000)}`, annotations: [] }] }]),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.script.push(textStep('Done.'));
    await env.runOnce(env.worker());
    const [truncated] = env.ofType(run.id, 'context.truncated').filter((event) => event.kind === 'omitted' && event.callId === 'c1');
    const tokens = (truncated as unknown as { tokens?: number } | undefined)?.tokens;
    expect(Number.isInteger(tokens)).toBe(true);
    expect(tokens).toBeGreaterThanOrEqual(60_000 / 8);
    expect(tokens).toBeLessThanOrEqual(60_000);
  });
});
