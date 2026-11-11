import { describe, expect, it } from 'vitest';
import type { AddGoverningFactInput } from '@momonga/store';
import { makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const GOVERNING_TEXT = 'Never use pandas.';

const added = (env: Env, overrides: Partial<AddGoverningFactInput> = {}) =>
  env.store.governing.add({
    kind: 'constraint',
    target: 'pandas',
    text: GOVERNING_TEXT,
    scope: { level: 'project', project: env.session.cwd, paths: [] },
    validUntil: null,
    supersedes: [],
    enforcement: null,
    source: { kind: 'command' },
    ...overrides,
  }).fact;

const toolNamesOf = (body: unknown): string[] => ((body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
const inputOf = (body: unknown): unknown[] => (body as { input: unknown[] }).input;

const runWithMidClaimFact = async (cachePrefix: boolean, overrides: Partial<AddGoverningFactInput>) => {
  const env = await makeEnv();
  env.settings.contextValue = { ...env.settings.contextValue, cachePrefix };
  env.toolbox.hooks.Echo = async () => {
    added(env, overrides);
  };
  env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
  const run = await env.enqueue('Echo then finish');
  await env.runOnce(env.worker());
  return { env, run, requests: env.ofType(run.id, 'model.requested') };
};

describe('the offer is composed at claim start under context.cachePrefix (4.2, 0.2 #1)', () => {
  it('keeps a tool offered within the claim after an enforced deny rule for it is added mid-claim', async () => {
    const { requests } = await runWithMidClaimFact(true, { enforcement: { behavior: 'deny', rule: 'Write' } });

    expect(requests).toHaveLength(2);
    expect(toolNamesOf(requests[0]?.body)).toContain('Write');
    expect(toolNamesOf(requests[1]?.body)).toContain('Write');
  });

  it('drops the tool at the next build without the setting', async () => {
    const { requests } = await runWithMidClaimFact(false, { enforcement: { behavior: 'deny', rule: 'Write' } });

    expect(toolNamesOf(requests[1]?.body)).not.toContain('Write');
  });
});

describe('governing is resolved per build, last in F, as governing_changed (Q2, section 1, 4.1)', () => {
  it('renders a fact added mid-claim as the last item of F and records the break as governing_changed', async () => {
    const { env, run, requests } = await runWithMidClaimFact(true, {});

    const first = inputOf(requests[0]?.body);
    const second = inputOf(requests[1]?.body);
    const governingAt = second.findIndex((item) => textOf(item).includes(GOVERNING_TEXT));
    const taskAt = second.findIndex((item) => textOf(item).includes('Echo then finish'));
    expect(first.some((item) => textOf(item).includes(GOVERNING_TEXT))).toBe(false);
    expect(governingAt).toBe(1);
    expect(taskAt).toBe(governingAt + 1);
    expect(requests[1]?.prefix).toEqual({ preservedItems: 1, toolsChanged: false, causes: ['governing_changed'] });
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  });
});
