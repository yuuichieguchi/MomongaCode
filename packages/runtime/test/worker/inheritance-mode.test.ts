import { describe, expect, it } from 'vitest';
import { LeaseLostError } from '@momonga/runtime';
import { canonicalJson } from '@momonga/foundation';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { PermissionMode, RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { MODEL_ID, assistantMessage, textStep } from './scripts.ts';
import { envNeutralJson, firstConversation, firstRequestInput, resolvedInheritedOf as inheritedEventOf, modeChangedText, modeMarkersOf, settle } from './inheritance-support.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const answered = async (env: Env, task: string, answer: string): Promise<string> => {
  env.gateway.script.push(textStep(answer));
  const run = await env.enqueue(task);
  expect((await settle(env, run.id)).status).toBe('COMPLETED');
  return run.id;
};

const answeredWithoutRecordedMode = async (env: Env, task: string, answer: string): Promise<string> => {
  const run = await env.enqueue(task);
  const payloads: RunEventPayload[] = [
    { type: 'run.started', attempt: 1, now: env.clock.now(), pins: {} },
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { model: MODEL_ID, input: 'seed' } },
    { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantMessage('msg_old', answer)], usage: USAGE } },
  ];
  const claim = await env.seed(run.id, payloads, 'hold');
  expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  expect(env.fold(run.id).mode).toBeUndefined();
  return run.id;
};

const claimedFirstAsCancelling = async (env: Env, task: string): Promise<string> => {
  const run = await env.enqueue(task);
  await env.seed(run.id, [], 'crash');
  expect((await env.cancel(run.id)).status).toBe('CANCELLING');
  await env.runOnce(env.worker());
  expect(env.run(run.id).status).toBe('CANCELLED');
  expect(env.ofType(run.id, 'run.started')).toEqual([]);
  return run.id;
};

const inheritOnce = async (env: Env, task: string): Promise<string> => {
  env.gateway.script.push(textStep('Answered.'));
  const run = await env.enqueue(task);
  await env.runOnce(env.worker());
  return run.id;
};

describe('mode_changed marker between runs', () => {
  it('adds no marker when the mode is unchanged', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello.');
    const second = await inheritOnce(env, 'Again');
    const event = inheritedEventOf(env, second);
    expect(event.markers).toEqual([]);
    expect(event.mode).toBe('manual');
    expect(modeMarkersOf(event.history)).toEqual([]);
  });

  it('ends the inherited history with the plan notice after a PATCH from manual to plan', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello.');
    env.setMode('plan');
    const second = await inheritOnce(env, 'Now plan');
    const event = inheritedEventOf(env, second);
    expect(event.history.at(-1)?.item).toEqual({ type: 'message', role: 'user', content: modeChangedText('manual', 'plan') });
    expect(event.markers.at(-1)?.kind).toBe('mode_changed');
    expect(event.fromMode).toBe('manual');
    expect(event.mode).toBe('plan');
    expect(firstConversation(env, second).slice(-2)).toEqual([
      ['user', modeChangedText('manual', 'plan')],
      ['user', 'Now plan'],
    ]);
  });

  const pairs = PERMISSION_MODES.flatMap((from) => PERMISSION_MODES.filter((to) => to !== from).map((to) => [from, to] as [PermissionMode, PermissionMode]));

  it.each(pairs)('announces %s to %s with the label and the rule of the new mode', async (from, to) => {
    const env = await makeEnv({ mode: from });
    await answered(env, 'Say hello', 'Hello.');
    env.setMode(to);
    const second = await inheritOnce(env, 'Next');
    const event = inheritedEventOf(env, second);
    expect(modeMarkersOf(event.history)).toEqual([modeChangedText(from, to)]);
    expect(event.mode).toBe(to);
  });

  it('adds no marker after a change and change back', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello.');
    env.setMode('plan');
    env.setMode('manual');
    const second = await inheritOnce(env, 'Again');
    expect(inheritedEventOf(env, second).markers).toEqual([]);
  });

  it('adds no marker when the source never recorded a mode, and records the current mode', async () => {
    const env = await makeEnv();
    await answeredWithoutRecordedMode(env, 'Old run', 'Old answer.');
    env.setMode('plan');
    const second = await inheritOnce(env, 'New run');
    const event = inheritedEventOf(env, second);
    expect(event.markers).toEqual([]);
    expect(event.fromMode).toBeUndefined();
    expect(event.mode).toBe('plan');
  });

  it('records the current mode for a run that never reaches run.started, so a later PATCH is announced exactly once (R4-3)', async () => {
    const env = await makeEnv();
    await answeredWithoutRecordedMode(env, 'Old run', 'Old answer.');
    env.setMode('plan');
    const second = await claimedFirstAsCancelling(env, 'Cancelled early');
    expect(inheritedEventOf(env, second).markers).toEqual([]);
    expect(env.fold(second).mode).toBe('plan');

    env.setMode('acceptEdits');
    const third = await inheritOnce(env, 'Third');

    expect(modeMarkersOf(inheritedEventOf(env, third).history)).toEqual([modeChangedText('plan', 'acceptEdits')]);
  });

  it('does not announce the same change twice when the announcing run never reached run.started (N2)', async () => {
    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello.');
    env.setMode('plan');
    const second = await claimedFirstAsCancelling(env, 'Cancelled early');
    expect(modeMarkersOf(inheritedEventOf(env, second).history)).toEqual([modeChangedText('manual', 'plan')]);
    expect(env.fold(second).mode).toBe('plan');

    const third = await inheritOnce(env, 'Third');

    expect(modeMarkersOf(inheritedEventOf(env, third).history)).toEqual([modeChangedText('manual', 'plan')]);
    expect(inheritedEventOf(env, third).mode).toBe('plan');
  });
});

describe('mode notice on recovery', () => {
  const countingStore = (env: Env, calls: string[]): RuntimeStore => ({
    ...env.store,
    inheritContext: (claim, options) => {
      calls.push(`${claim.runId}#${claim.attempt}`);
      return env.store.inheritContext(claim, options);
    },
  });

  it('keeps the journaled marker after a crash past the inherit append and a later PATCH, and builds the same request as a control run', async () => {
    const control = await makeEnv();
    await answered(control, 'Say hello', 'Hello.');
    control.setMode('plan');
    const controlRun = await inheritOnce(control, 'Plan it');

    const env = await makeEnv();
    await answered(env, 'Say hello', 'Hello.');
    env.setMode('plan');
    const calls: string[] = [];
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
    env.gateway.script.push(textStep('Answered.'));
    const second = await env.enqueue('Plan it');
    await env.runOnce(env.worker('worker-1', { store: countingStore(env, calls), tools }));
    expect(env.run(second.id).status).toBe('RUNNING');
    const journaled = inheritedEventOf(env, second.id);
    expect(modeMarkersOf(journaled.history)).toEqual([modeChangedText('manual', 'plan')]);

    env.setMode('acceptEdits');
    env.clock.advance(120_000);
    await env.runOnce(env.worker('worker-2', { store: countingStore(env, calls), tools }));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(calls).toEqual([`${second.id}#1`]);
    expect(canonicalJson(inheritedEventOf(env, second.id))).toBe(canonicalJson(journaled));
    expect(env.fold(second.id).mode).toBe('acceptEdits');
    expect(envNeutralJson(env, firstRequestInput(env, second.id))).toBe(envNeutralJson(control, firstRequestInput(control, controlRun)));
  });
});
