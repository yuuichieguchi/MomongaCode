import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, compactKey, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { bigStep, bigTool, padOf, recordingStore, stealLease, withinTurnWorker } from './within-turn-support.ts';

const W4000 = capabilitiesFor(4000);

describe('recovery inside one turn', () => {
  it('reuses the compaction key for an identical render after a crash between compact and context.compacted', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...[0, 1, 2, 3, 4, 5].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 1550) })), textStep('done'));
    const run = env.enqueue('Fill the context');
    let crashed = false;
    const steals: Promise<void>[] = [];
    const { store } = recordingStore(env, (payloads) => {
      if (!crashed && payloads.some((payload) => payload.type === 'context.compacted')) {
        crashed = true;
        steals.push(stealLease(env));
      }
    });

    await env.runOnce(env.worker('worker-1', { ...withinTurnWorker(), store }));
    await Promise.all(steals);
    expect(crashed).toBe(true);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);

    await env.runOnce(env.worker('worker-2', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(2);
    const [first, second] = env.gateway.compacts;
    expect(second?.request).toEqual(first?.request);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(first?.idempotencyKey).toBe(compactKey(run.id, first?.request ?? { model: '', input: [] }));
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
  });

  it('keeps the same eviction set after a crash between context.truncated and model.requested', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...[...'abcdefgh'].map((letter, index) => bigStep(`k${index}`, { letter, size: 1800, pad: '' })), textStep('done'));
    const run = env.enqueue('Fill the context');
    let crashed = false;
    const steals: Promise<void>[] = [];
    const { store } = recordingStore(env, (payloads) => {
      if (!crashed && payloads.some((payload) => payload.type === 'model.requested') && env.ofType(run.id, 'context.truncated').length > 0) {
        crashed = true;
        steals.push(stealLease(env));
      }
    });

    await env.runOnce(env.worker('worker-1', { ...withinTurnWorker(), store }));
    await Promise.all(steals);
    expect(crashed).toBe(true);
    const journaledBefore = env.ofType(run.id, 'context.truncated').map((event) => event.callId);
    expect(journaledBefore).toHaveLength(1);

    await env.runOnce(env.worker('worker-2', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const truncated = env.ofType(run.id, 'context.truncated').map((event) => event.callId);
    expect(new Set(truncated).size).toBe(truncated.length);
    expect(truncated.slice(0, 1)).toEqual(journaledBefore);
    expect(truncated).toEqual(env.ofType(run.id, 'tool.call').map((event) => event.callId).slice(0, 4));
  });

  it('makes the same compaction after a WAITING_HUMAN resume with a fresh meter as a run without the pause', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.rewriteCallIds = false;
    const target = path.join(env.project, 'w.txt');
    const script = () => [
      bigStep('k0', { letter: 'a', size: 0, pad: padOf(0, 1400) }),
      bigStep('k1', { letter: 'a', size: 0, pad: padOf(1, 1400) }),
      callsStep([{ callId: 'w2', name: 'Write', args: { file_path: target, content: 'x' } }]),
      ...[3, 4, 5, 6].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 1550) })),
      textStep('done'),
    ];
    const overrides = { ...withinTurnWorker(), toolList: () => [bigTool(), ...env.toolbox.tools().filter((tool) => tool.name === 'Write')] };

    env.setMode('acceptEdits');
    env.gateway.script.push(...script());
    const straight = env.enqueue('Fill the context', { history: 'fresh' });
    await env.runOnce(env.worker('worker-1', overrides));
    expect(env.run(straight.id).status).toBe('COMPLETED');

    env.setMode('manual');
    env.gateway.script.push(...script());
    const paused = env.enqueue('Fill the context', { history: 'fresh' });
    await env.runOnce(env.worker('worker-2', overrides));
    expect(env.run(paused.id).status).toBe('WAITING_HUMAN');
    await env.resolveApproval(paused.id, 'allow_once');
    await env.runOnce(env.worker('worker-3', overrides));
    expect(env.run(paused.id).status).toBe('COMPLETED');

    expect(env.gateway.compacts).toHaveLength(2);
    const [first, second] = env.gateway.compacts;
    expect(second?.request).toEqual(first?.request);
    expect(env.ofType(paused.id, 'context.compacted').map((event) => event.replacedThroughSeq)).toEqual(
      env.ofType(straight.id, 'context.compacted').map((event) => event.replacedThroughSeq),
    );
    expect(second?.idempotencyKey).toBe(compactKey(paused.id, second?.request));
  });
});
