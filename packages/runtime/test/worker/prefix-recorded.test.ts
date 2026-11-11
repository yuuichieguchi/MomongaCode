import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const inputOf = (body: unknown): unknown[] => (body as { input: unknown[] }).input;

describe('model.requested records the prefix relation to the previous request of the run (section 1)', () => {
  it('records the whole previous request as preserved when no named event lies between two requests', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = await env.enqueue('Echo then finish');

    await env.runOnce(env.worker());

    const [first, second] = env.ofType(run.id, 'model.requested');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(second?.prefix).toEqual({ preservedItems: inputOf(first?.body).length, toolsChanged: false, causes: [] });
    expect(inputOf(second?.body).slice(0, inputOf(first?.body).length)).toEqual(inputOf(first?.body));
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  });

  it('attributes a changed offer at a new claim to the claim event, with the tools changed', async () => {
    const env = await makeEnv();
    env.toolbox.hooks.Echo = async () => {
      const changed = env.store.setPermissionMode(env.session.id, 'plan');
      if (changed.kind !== 'ok') throw new Error(`the mode could not be changed: ${changed.kind}`);
    };
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = await env.enqueue('Echo then finish');

    await env.runOnce(env.worker());
    await env.runOnce(env.worker());

    const [, second] = env.ofType(run.id, 'model.requested');
    expect(second?.prefix).toEqual({ preservedItems: 0, toolsChanged: true, causes: ['claim'] });
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  });
});

describe('the per-step journal reads are bounded by the step (conformance-1-24)', () => {
  it('reads the break events after the previous request only, and reads no truncation list per build', async () => {
    const env = await makeEnv();
    const steps = 8;
    env.gateway.script.push(...Array.from({ length: steps }, (_, index) => callsStep([{ callId: `c${index}`, name: 'Echo', args: { value: `v${index}` } }])), textStep('Done.'));
    const run = await env.enqueue('Echo many times');
    const reads: { types: readonly string[]; afterSeq: number | undefined; seqs: number[] }[] = [];
    const read = env.store.readRunEventsOfTypes.bind(env.store);
    env.store.readRunEventsOfTypes = (runId, types, afterSeq) => {
      const events = read(runId, types, afterSeq);
      if (runId === run.id) reads.push({ types, afterSeq, seqs: events.map((event) => event.seq) });
      return events;
    };

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const requests = env.ofType(run.id, 'model.requested');
    const breakReads = reads.filter((entry) => entry.types.includes('tool.loaded'));
    expect(breakReads).toHaveLength(requests.length - 1);
    breakReads.forEach((entry, index) => {
      expect(entry.afterSeq).toBe(requests[index]?.seq);
      for (const seq of entry.seqs) expect(seq).toBeGreaterThan(entry.afterSeq ?? 0);
    });
    expect(reads.filter((entry) => entry.types.length === 1 && entry.types[0] === 'context.truncated')).toEqual([]);
  });
});
