import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VERIFICATION_COMMANDS, DEFAULT_VERIFICATION_MANIFESTS } from '@momonga/config';
import type { RunEventPayload } from '@momonga/protocol';
import { createFakeTimers, usageOf } from '@momonga/testkit';
import type { RuntimeStore } from '@momonga/store';
import { enqueue, harness, makeStoreDir, mustClaim, newSession } from '../../../store/test/helpers.ts';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { textStep } from '../worker/scripts.ts';
import { bash, exported, fileTool, checked, finishClaimed } from './reflection-fixture.ts';

type Job = { state: string; attempts: number; lastError: string | null };

type Api = {
  reflection: { get(runId: string): Job | undefined };
  contextCharges: { list(): Record<string, unknown>[] };
};

type Reflector = { runOne(signal: AbortSignal): Promise<'idle' | 'busy' | 'ran'> };

const SIGNAL = new AbortController().signal;
const SHA = 'a'.repeat(64);
const REPLY = JSON.stringify({ candidates: [] });

const pinsWith = (roles: Record<string, string> | undefined): Record<string, unknown> => ({
  model: 'fm',
  systemPromptDigest: 'system-prompt-digest',
  toolSetDigest: 'tool-set-digest',
  capabilities: { contextWindow: 100_000, maxOutputTokens: 4096, parallelToolCalls: false, streaming: true, tokenCounting: 'exact', toolCalling: 'native' },
  ...(roles === undefined ? {} : { roles }),
});

const setup = () => {
  const opened = harness();
  const { clock } = opened;
  const store = withInProcessFacts(opened.store, opened.dbPath);
  const project = makeStoreDir();
  store.trust.set(project, 'trusted');
  const session = newSession(store, project);
  const gateway = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));
  const settings = {
    trusted: (target: { cwd: string }) => store.trust.decisionFor(target.cwd).decision === 'trusted',
    verification: async () => ({ commands: [...DEFAULT_VERIFICATION_COMMANDS], manifests: [...DEFAULT_VERIFICATION_MANIFESTS] }),
    memory: async () => ({ reflection: { enabled: true }, forgetAfterDays: 90 }),
  };
  const reflector = (): Reflector =>
    exported<(options: unknown) => Reflector>('createReflector')({
      store,
      gateway,
      settings,
      clock,
      isIdle: () => true,
      evidenceRun: () => async () => ({ exitCode: null }),
      maxAttempts: 3,
      attemptTimeoutMs: 600_000,
      timers: createFakeTimers(clock),
      random: () => 0.5,
    });
  const verified: RunEventPayload[] = [...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SHA, access: 'write' }), ...checked('npm test', 0, 'ok')];
  const finishedRun = async (roles: Record<string, string> | undefined) => {
    const run = enqueue(store, session.id, 'fix the bug');
    await finishClaimed(store, verified, 'COMPLETED', pinsWith(roles));
    return run;
  };
  return { store, api: store as unknown as Api, gateway, settings, reflector, finishedRun, project, session, verified };
};

describe('the reflection role', () => {
  it('guards a role that is ignored: the call, its capabilities and its charge go to the pinned reflection model', async () => {
    const env = setup();
    env.gateway.capabilitiesByModel['cheap'] = capabilitiesFor(100_000, { structuredOutput: 'json_schema' });
    const run = await env.finishedRun({ reflection: 'cheap' });
    env.gateway.script.push(textStep(REPLY, { usage: usageOf(100, 20) }));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['cheap']);
    expect(env.gateway.streams.map((stream) => stream.role)).toEqual(['reflection']);
    expect(env.gateway.streams.map((stream) => stream.body.momonga?.exact_model)).toEqual([true]);
    expect(env.gateway.capabilityRequests).toEqual(['cheap']);
    expect(env.api.contextCharges.list()).toMatchObject([{ purpose: 'reflection', runId: (await run).id, model: 'cheap', inputTokens: 100, outputTokens: 20, totalTokens: 120 }]);
  });

  it('guards a cap taken from the wrong model: the output cap follows the capabilities of the role model', async () => {
    const env = setup();
    env.gateway.capabilitiesByModel['cheap'] = capabilitiesFor(8192, { structuredOutput: 'json_schema' });
    await env.finishedRun({ reflection: 'cheap' });
    env.gateway.script.push(textStep(REPLY));
    await env.reflector().runOne(SIGNAL);
    expect(env.gateway.streams[0]?.body.max_output_tokens).toBe(492);
  });

  it('guards a default that moves: a run pinned with no reflection role reflects on the run model, whatever the settings say now', async () => {
    const env = setup();
    await env.finishedRun({ compaction: 'cheap' });
    env.gateway.script.push(textStep(REPLY));
    await env.reflector().runOne(SIGNAL);
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['fm']);
  });

  it('guards a run recorded before roles existed: pins without roles reflect on the run model', async () => {
    const env = setup();
    await env.finishedRun(undefined);
    env.gateway.script.push(textStep(REPLY));
    await env.reflector().runOne(SIGNAL);
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['fm']);
  });

  it('guards a charge spent on a target that cannot enforce the schema: a reflection target reporting no structured output is not called and ends done naming the role and the alias', async () => {
    const env = setup();
    env.gateway.capabilitiesByModel['plain'] = capabilitiesFor(100_000, { structuredOutput: 'none' });
    const run = await env.finishedRun({ reflection: 'plain' });
    env.gateway.script.push(textStep(REPLY, { usage: usageOf(100, 20) }));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    expect(env.gateway.capabilityRequests).toEqual(['plain']);
    expect(env.gateway.streams).toEqual([]);
    expect(env.api.contextCharges.list()).toEqual([]);
    const job = env.api.reflection.get((await run).id);
    expect(job?.state).toBe('done');
    expect(job?.lastError).toContain('models.roles.reflection');
    expect(job?.lastError).toContain('plain');
  });

  it('guards a blanket skip: a reflection target reporting json_schema is still called and charged', async () => {
    const env = setup();
    env.gateway.capabilitiesByModel['strict'] = capabilitiesFor(100_000, { structuredOutput: 'json_schema' });
    const run = await env.finishedRun({ reflection: 'strict' });
    env.gateway.script.push(textStep(REPLY, { usage: usageOf(100, 20) }));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['strict']);
    expect(env.api.reflection.get((await run).id)?.state).toBe('done');
    expect(env.api.contextCharges.list()).toMatchObject([{ purpose: 'reflection', model: 'strict', inputTokens: 100, outputTokens: 20 }]);
  });
});

describe('the reflection call is admitted by the budget of its run', () => {
  it('is not sent when the tokens left of the run do not pay for it, and the job ends done saying so', async () => {
    const env = setup();
    const created = env.store.createRunAndEnqueue(env.session.id, { input: 'fix the bug', timeoutMs: 600_000, limits: { maxSteps: 10, maxTotalTokens: 20 }, pins: { model: 'fm' } });
    if (created.kind !== 'created') throw new Error(`expected a run, got ${created.kind}`);
    await finishClaimed(env.store, env.verified, 'COMPLETED', pinsWith(undefined));
    env.gateway.script.push(textStep(REPLY, { usage: usageOf(100, 20) }));

    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');

    expect(env.gateway.streams).toEqual([]);
    expect(env.api.contextCharges.list()).toEqual([]);
    const job = env.api.reflection.get(created.run.id);
    expect(job?.state).toBe('done');
    expect(job?.lastError).toContain('budget');
  });
});
