import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import type { RunEventPayload } from '@momonga/protocol';
import { compactInputOf, compactPinOf } from '../../src/worker/compact-pin.ts';
import { FAKE_ADAPTER, FAKE_PROVIDER, PRIMARY_TARGET } from './fake-gateway.ts';
import { capabilitiesFor, createdRun, makeEnv } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const THE_SENDER = 'worker/admitted-request.ts';
const SENDS_A_MODEL_REQUEST = /\.\s*(stream|compact)\s*\(/;
const PRICES = definePriceTable([{ provider: FAKE_PROVIDER, model: 'upstream-a', effectiveFrom: '2026-01-01', inputPerMTok: 0.001, outputPerMTok: 15, currency: 'USD' }]);
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 200_000;
const HOUR_MS = 3_600_000;

type Env = Awaited<ReturnType<typeof makeEnv>>;

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const metered = (env: Env): void => {
  env.gateway.chainsByModel[env.session.model] = [PRIMARY_TARGET];
  env.gateway.memberFacts = { [PRIMARY_TARGET]: { adapter: FAKE_ADAPTER, upstream: 'upstream-a', answers: 'model', billing: 'metered', provider: FAKE_PROVIDER } };
  env.gateway.billed = { inputPerMTok: 0.001, outputPerMTok: 15 };
  env.gateway.prices = PRICES;
};

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const conversation: RunEventPayload[] = [
  responded(1, [assistantMessage('m1', `answer one ${'x'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(2, [assistantMessage('m2', `answer two ${'y'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question three' },
  responded(3, [assistantMessage('m3', `answer three ${'z'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question four' },
  responded(4, [assistantMessage('m4', `answer four ${'w'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question five' },
];

const conversed = async (): Promise<Env> => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  metered(env);
  const first = env.enqueue('question one');
  await env.seed(first.id, conversation, 'release');
  env.gateway.script.push(textStep('Done.'));
  await env.runOnce(env.worker());
  expect(env.run(first.id).status).toBe('COMPLETED');
  return env;
};

const enqueueCompact = (env: Env, limits: Record<string, number>) =>
  createdRun(env.store.createRunAndEnqueue(env.session.id, { input: compactInputOf(undefined), timeoutMs: HOUR_MS, limits, pins: compactPinOf(undefined), history: 'inherit' }));

describe('every model request of the runtime is admitted by the one budget', () => {
  it('sends a model request from one file only, the one that takes the admission', () => {
    const senders = sourceFiles(SOURCE_ROOT)
      .filter((file) => SENDS_A_MODEL_REQUEST.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SOURCE_ROOT, file));

    expect(senders).toEqual([THE_SENDER]);
  });

  it('stops the run with budget.exhausted before a compaction the money left does not pay for', async () => {
    const env = await conversed();
    const run = enqueueCompact(env, { maxCostUsd: 0.000001 });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'cost', limit: 1000 })]);
    expect(env.gateway.compacts).toEqual([]);
    expect(env.ofType(run.id, 'context.compacting')).toEqual([]);
  });

  it('stops the run before a compaction the tokens left do not pay for', async () => {
    const env = await conversed();
    const run = enqueueCompact(env, { maxTotalTokens: 100 });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'tokens', limit: 100 })]);
    expect(env.gateway.compacts).toEqual([]);
  });

  it('sends an admitted compaction with the ceiling of its reservation and holds no reservation afterwards', async () => {
    const env = await conversed();
    const run = enqueueCompact(env, { maxCostUsd: 5 });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    const ceiling = env.gateway.compacts[0]?.request.momonga as { max_cost_nano?: number; max_input_tokens?: number } | undefined;
    expect(ceiling?.max_cost_nano).toBeGreaterThan(0);
    expect(ceiling?.max_cost_nano).toBeLessThanOrEqual(5_000_000_000);
    expect(ceiling?.max_input_tokens).toBeGreaterThan(0);
    expect(env.store.treeSpend(run.id)).toMatchObject({ reservedNano: 0, reservedTokens: 0 });
  });

  it('sends a compaction of a run without a money limit with no ceiling', async () => {
    const env = await conversed();
    const run = enqueueCompact(env, {});

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts[0]?.request.momonga).not.toHaveProperty('max_cost_nano');
  });

  it('skips the permission classifier the budget does not pay for: the call asks a person and a notice says why', async () => {
    const env = await makeEnv({ mode: 'auto' });
    metered(env);
    env.settings.classifierModel = 'guard';
    env.gateway.capabilitiesByModel['guard'] = capabilitiesFor(env.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]), textStep('never the classifier reply'));
    const run = env.enqueue('Write out.txt', { limits: { maxCostUsd: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.gateway.script).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.permission.classified')).toEqual([expect.objectContaining({ outcome: 'ask', failure: expect.stringContaining('budget') })]);
    expect(env.fold(run.id).notes.some((note) => note.code === 'budget_auxiliary_skipped')).toBe(true);
  });

  it('sends an admitted classifier request with the ceiling of its reservation', async () => {
    const env = await makeEnv({ mode: 'auto' });
    metered(env);
    env.gateway.chainsByModel['guard'] = [PRIMARY_TARGET];
    env.settings.classifierModel = 'guard';
    env.gateway.capabilitiesByModel['guard'] = capabilitiesFor(env.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
    env.gateway.script.push(
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]),
      textStep(JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'ok' })),
      textStep('Written.'),
    );
    const run = env.enqueue('Write out.txt', { limits: { maxCostUsd: 5 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const classifierBody = env.gateway.streams.find((stream) => stream.body.model === 'guard')?.body;
    expect(classifierBody?.momonga?.max_cost_nano).toBeGreaterThan(0);
    expect(classifierBody?.momonga?.max_input_tokens).toBeGreaterThan(0);
    expect(env.store.treeSpend(run.id)).toMatchObject({ reservedNano: 0, reservedTokens: 0 });
  });
});
