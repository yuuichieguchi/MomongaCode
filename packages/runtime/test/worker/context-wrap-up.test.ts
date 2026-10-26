import { describe, expect, it } from 'vitest';
import type { InputItem, RunEventPayload } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { wrapUpInstructionFor } from '../../src/worker/wrap-up.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { bigStep, gatewayError, inputOf, recordingStore, stealLease, withinTurnWorker } from './within-turn-support.ts';
import { callsStep } from './scripts.ts';

const LONG_DESCRIPTION = 'd'.repeat(4000);
const CONTEXT_INSTRUCTION: InputItem = { type: 'message', role: 'user', content: wrapUpInstructionFor('context') };

const isStopNotice = (payload: RunEventPayload): boolean => payload.type === 'notice' && payload.message.startsWith('The context needs');

const overflowScript = (): ScriptStep[] => [bigStep('k0', { letter: 'a', size: 0, pad: 'p'.repeat(7400) })];

describe('context-overflow wrap-up (path 3)', () => {
  it('makes one tool-less model call with the counted instruction last and stops with budget after the reply', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.gateway.script.push(...overflowScript(), textStep('Here is what I did.'));
    const run = env.enqueue('Fill the context');
    const { store, appends } = recordingStore(env);

    await env.runOnce(env.worker('worker-1', { ...withinTurnWorker(LONG_DESCRIPTION), store }));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.streams).toHaveLength(2);
    const wrapUp = env.gateway.streams[1]?.body;
    expect(wrapUp?.tool_choice).toBe('none');
    expect(wrapUp?.tools ?? []).toEqual([]);
    expect(inputOf(wrapUp ?? {}).at(-1)).toEqual(CONTEXT_INSTRUCTION);
    expect(env.fold(run.id).steps[2]?.summary).toBe(true);

    const notice = env.ofType(run.id, 'notice').find((event) => event.message.startsWith('The context needs'));
    expect(notice?.message).toContain('a final summary was requested');
    const requested = env.ofType(run.id, 'model.requested').find((event) => event.step === 2);
    expect(notice?.seq).toBe((requested?.seq ?? 0) - 1);
    const together = appends.filter((payloads) => payloads.some(isStopNotice));
    expect(together).toHaveLength(1);
    expect(together[0]?.map((payload) => payload.type)).toEqual(['notice', 'model.requested']);
  });

  it('ends STOPPED budget with the gateway code when the wrap-up call is rejected with a 400', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.gateway.script.push(...overflowScript(), { events: [], error: gatewayError(400, 'invalid_request', 'invalid_request') });
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker(LONG_DESCRIPTION)));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.ofType(run.id, 'notice').some((event) => event.message.includes('(invalid_request)'))).toBe(true);
    expect(env.ofType(run.id, 'model.requested').find((event) => event.step === 2)?.body).toMatchObject({ tool_choice: 'none' });
  });

  it('cannot leave a stop notice behind a crash before the wrap-up request, and a recovery rebuild that fits continues the run', async () => {
    const capabilities = capabilitiesFor(4000, { tokenCounting: 'estimated' });
    const env = await makeEnv({ capabilities });
    env.gateway.script.push(
      callsStep([{ callId: 'k0', name: 'Big', args: { letter: 'a', size: 0, pad: 'p'.repeat(4920) } }], usageOf(1000, 10)),
      textStep('Continued normally.'),
    );
    const run = env.enqueue('Fill the context');
    let crashed = false;
    const { store, appends } = recordingStore(env, (payloads) => {
      if (!crashed && payloads.some(isStopNotice)) {
        crashed = true;
        stealLease(env);
      }
    });

    await env.runOnce(env.worker('worker-1', { ...withinTurnWorker(), store }));

    expect(crashed).toBe(true);
    const crashedAppend = appends.find((payloads) => payloads.some(isStopNotice));
    expect(crashedAppend?.map((payload) => payload.type)).toEqual(['notice', 'model.requested']);
    expect(env.ofType(run.id, 'notice').filter((event) => event.message.startsWith('The context needs'))).toEqual([]);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);

    await env.runOnce(env.worker('worker-2', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'notice').filter((event) => event.message.startsWith('The context needs'))).toEqual([]);
    const resumed = env.ofType(run.id, 'model.requested').find((event) => event.step === 2);
    expect(resumed?.body).toMatchObject({ tool_choice: 'auto' });
    expect(env.fold(run.id).steps[2]?.summary).toBe(false);
  });
});
