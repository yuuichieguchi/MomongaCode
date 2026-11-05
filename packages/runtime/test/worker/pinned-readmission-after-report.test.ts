import { describe, expect, it } from 'vitest';
import { MIN_ROOM_TOKENS, budgetFor, inputCeilingFor } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { createGovernancePort } from '@momonga/runtime';
import { defineTool } from '@momonga/tools';
import { inputTokensOf } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const WINDOW = 4096;
const OUTPUT = 1024;
const SLACK = 40;

const sized = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: OUTPUT, tokenCounting: 'estimated' });
const ceiling = inputCeilingFor(sized());

const toolNamed = (name: string, description: string, execute: () => void = () => undefined) =>
  defineTool<Record<string, never>>({
    name,
    description,
    kind: name === 'Glob' ? 'search' : 'other',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    title: () => name,
    subject: () => ({ kind: 'none', tool: name }),
    execute: async () => {
      execute();
      return { status: 'completed', output: name };
    },
  });

const estimatedEnv = async (): Promise<Env> => {
  const env = await makeEnv({ capabilities: sized(), mode: 'bypassPermissions' });
  env.gateway.countMethod = 'estimated';
  return env;
};

const denyGlob = (env: Env) =>
  env.store.governing.add({
    kind: 'constraint',
    target: 'glob',
    text: 'Do not use Glob.',
    scope: { level: 'project', project: env.session.cwd, paths: [] },
    validUntil: null,
    supersedes: [],
    enforcement: { behavior: 'deny', rule: 'Glob' },
    source: { kind: 'command' },
  }).fact;

const firstRequestTokens = async (task: string, tools: () => ReturnType<typeof toolNamed>[], governed: boolean): Promise<number> => {
  const env = await estimatedEnv();
  if (governed) denyGlob(env);
  env.gateway.script.push(textStep('Done.'));
  env.enqueue(task);
  await env.runOnce(env.worker('probe', { toolList: tools, governance: createGovernancePort({ store: env.store, settings: env.settings }) }));
  const body = env.gateway.streams[0]?.body;
  if (body === undefined) throw new Error('the probe made no model call');
  return inputTokensOf(body);
};

const taskReaching = async (target: number, tools: () => ReturnType<typeof toolNamed>[]): Promise<string> => {
  const probe = await firstRequestTokens('y'.repeat(4), tools, true);
  return 'y'.repeat(4 + 4 * (target - probe));
};

type Scenario = { env: Env; runId: string; reported: number; firstEstimate: number; globTokens: number };

const retireMidRun = async (globDescription: string, spare: number): Promise<Scenario> => {
  const withGlob = () => [toolNamed('Glob', globDescription), toolNamed('Retire', 'Retires the rule')];
  const withoutGlob = () => [toolNamed('Retire', 'Retires the rule')];
  const globTokens = (await firstRequestTokens('y', withGlob, false)) - (await firstRequestTokens('y', withoutGlob, false));
  const task = await taskReaching(ceiling - MIN_ROOM_TOKENS - spare, withoutGlob);
  const firstEstimate = await firstRequestTokens(task, withoutGlob, true);
  const reported = firstEstimate + errorBoundOfShape(ESTIMATED_ERROR_SHAPE, firstEstimate);

  const env = await estimatedEnv();
  const fact = denyGlob(env);
  const tools = () => [toolNamed('Glob', globDescription), toolNamed('Retire', 'Retires the rule', () => env.store.governing.retire(fact.id))];
  env.gateway.script.push(callsStep([{ callId: 'call_r_1', name: 'Retire', args: {} }], usageOf(reported, 5)), textStep('Done.'));
  const run = env.enqueue(task);
  await env.runOnce(env.worker('w1', { toolList: tools, governance: createGovernancePort({ store: env.store, settings: env.settings }) }));
  return { env, runId: run.id, reported, firstEstimate, globTokens };
};

const offerAt = (env: Env, index: number): string[] => (env.gateway.streams[index]?.body.tools as { name: string }[]).map((tool) => tool.name);

describe('off mode: a fact retired mid-run, after the first request was reported within the estimator bound', () => {
  it('is sized so that the first build admits on the estimate, the report leaves room in the input budget, and the static ceiling would refuse the report', async () => {
    const { firstEstimate, reported, globTokens } = await retireMidRun('Finds files', SLACK);

    expect(ceiling - firstEstimate).toBeGreaterThanOrEqual(MIN_ROOM_TOKENS);
    expect(ceiling - (firstEstimate + globTokens)).toBeGreaterThanOrEqual(MIN_ROOM_TOKENS);
    expect(reported + MIN_ROOM_TOKENS).toBeLessThanOrEqual(budgetFor(sized(), 0).I);
    expect(ceiling - reported).toBeLessThan(MIN_ROOM_TOKENS);
  });

  it('returns the tool at the next build and re-admits it against the pinned check when it fits', async () => {
    const { env, runId } = await retireMidRun('Finds files', SLACK);

    expect(env.run(runId).error).toBeUndefined();
    expect(env.run(runId).status).toBe('COMPLETED');
    expect(offerAt(env, 0)).not.toContain('Glob');
    expect(offerAt(env, 1)).toContain('Glob');
    expect(env.ofType(runId, 'notice').map((notice) => notice.code)).not.toContain('tools_dropped');
  });

  it('re-admits against the pinned check when the returned tool would overflow, and fails there with the fresh count of the pinned part', async () => {
    const oversize = 'Finds files. '.repeat(120);
    const { env, runId, firstEstimate, globTokens } = await retireMidRun(oversize, SLACK);

    expect(ceiling - (firstEstimate + globTokens)).toBeLessThan(MIN_ROOM_TOKENS);
    const failed = env.run(runId);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('pinned_overflow');
    expect(failed.error?.message).toContain(`but at most ${ceiling} fit`);
    const needed = Number(/needs (\d+) tokens/.exec(failed.error?.message ?? '')?.[1]);
    expect(needed).toBeGreaterThan(ceiling);
    expect(needed).toBeLessThanOrEqual(firstEstimate + globTokens);
    expect(env.gateway.streams).toHaveLength(1);
  });
});
