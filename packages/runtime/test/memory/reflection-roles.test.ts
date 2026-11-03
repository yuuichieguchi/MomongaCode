import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VERIFICATION_COMMANDS, DEFAULT_VERIFICATION_MANIFESTS } from '@momonga/config';
import type { RunEventPayload } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import type { RuntimeStore } from '@momonga/store';
import { enqueue, harness, makeStoreDir, mustClaim, newSession } from '../../../store/test/helpers.ts';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { textStep } from '../worker/scripts.ts';
import { bash, exported, fileTool } from './reflection-fixture.ts';

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
  modelAlias: 'fm',
  systemPromptDigest: 'system-prompt-digest',
  toolSetDigest: 'tool-set-digest',
  capabilities: { contextWindow: 100_000, maxOutputTokens: 4096, parallelToolCalls: false, streaming: true, tokenCounting: 'exact', toolCalling: 'native' },
  ...(roles === undefined ? {} : { roles }),
});

const finishWithPins = (store: RuntimeStore, pins: Record<string, unknown>, events: readonly RunEventPayload[]): void => {
  const claim = mustClaim(store, 'w1');
  const appended = store.append(claim, [{ type: 'run.started', attempt: claim.attempt, now: 0, pins }, ...events]);
  if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
  const finished = store.transition(claim, ['RUNNING'], 'COMPLETED', {});
  if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
};

const setup = () => {
  const { store, clock } = harness();
  const project = makeStoreDir();
  store.trust.set(project, 'trusted');
  const session = newSession(store, project);
  const gateway = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));
  const settings = {
    trusted: (target: { cwd: string }) => store.trust.decisionFor(target.cwd).decision === 'trusted',
    verification: async () => ({ commands: [...DEFAULT_VERIFICATION_COMMANDS], manifests: [...DEFAULT_VERIFICATION_MANIFESTS] }),
    memory: async () => ({ reflection: { enabled: true }, forgetAfterDays: 90 }),
    modelRoles: () => ({ reflection: 'live-settings-alias' }),
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
      random: () => 0.5,
    });
  const verified: RunEventPayload[] = [...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SHA, access: 'write' }), ...bash('t1', 'npm test', 0, 'ok')];
  const finishedRun = (roles: Record<string, string> | undefined) => {
    const run = enqueue(store, session.id, 'fix the bug');
    finishWithPins(store, pinsWith(roles), verified);
    return run;
  };
  return { store, api: store as unknown as Api, gateway, settings, reflector, finishedRun, project };
};

describe('the reflection role', () => {
  it('guards a role that is ignored: the call, its capabilities and its charge go to the pinned reflection alias', async () => {
    const env = setup();
    env.gateway.capabilitiesByAlias['cheap'] = capabilitiesFor(100_000, { structuredOutput: 'json_schema' });
    const run = env.finishedRun({ reflection: 'cheap' });
    env.gateway.script.push(textStep(REPLY, { usage: usageOf(100, 20) }));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['cheap']);
    expect(env.gateway.capabilityRequests).toEqual(['cheap']);
    expect(env.api.contextCharges.list()).toMatchObject([{ purpose: 'reflection', runId: run.id, model: 'cheap', inputTokens: 100, outputTokens: 20, totalTokens: 120 }]);
  });

  it('guards a cap taken from the wrong model: the output cap follows the capabilities of the role alias', async () => {
    const env = setup();
    env.gateway.capabilitiesByAlias['cheap'] = capabilitiesFor(8192, { structuredOutput: 'json_schema' });
    env.finishedRun({ reflection: 'cheap' });
    env.gateway.script.push(textStep(REPLY));
    await env.reflector().runOne(SIGNAL);
    expect(env.gateway.streams[0]?.body.max_output_tokens).toBe(492);
  });

  it('guards a default that moves: a run pinned with no reflection role reflects on the run alias, whatever the settings say now', async () => {
    const env = setup();
    env.finishedRun({ compaction: 'cheap' });
    env.gateway.script.push(textStep(REPLY));
    await env.reflector().runOne(SIGNAL);
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['fm']);
  });

  it('guards a run recorded before roles existed: pins without roles reflect on the run alias', async () => {
    const env = setup();
    env.finishedRun(undefined);
    env.gateway.script.push(textStep(REPLY));
    await env.reflector().runOne(SIGNAL);
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['fm']);
  });

  it('guards a reply that cannot be held to the schema: a reflection role without structured output makes no call and ends the job naming the role and the capability', async () => {
    const env = setup();
    env.gateway.capabilitiesByAlias['plain'] = capabilitiesFor(100_000, { structuredOutput: 'none' });
    const run = env.finishedRun({ reflection: 'plain' });
    env.gateway.script.push(textStep(REPLY));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    expect(env.gateway.streams).toHaveLength(0);
    const job = env.api.reflection.get(run.id);
    expect(job?.state).toBe('done');
    expect(job?.lastError).toContain('models.roles.reflection');
    expect(job?.lastError).toContain('plain');
    expect(job?.lastError).toContain('structured output');
    expect(env.api.contextCharges.list()).toEqual([]);
  });
});
