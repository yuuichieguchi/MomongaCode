import { describe, expect, it } from 'vitest';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const SHELL_OUTPUT_CHARS = 200_000;
const REQUEST_BOUND_CHARS = 100_000;
const SMALL_SHELL_OUTPUT = 'small output line kept whole';

const runProblemsOf = (events: readonly { type: string }[], label: string) =>
  events.filter((e) => e.type === 'run.stopped' || e.type === 'notice' || e.type === 'budget.exhausted').map((e) => label + JSON.stringify(e).slice(0, 300));

describe('a user shell output of an earlier run, inherited by a later run on a small window', () => {
  it('reaches the later run bounded, and the later run completes', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8192) });
    env.store.userShell.record(env.session.id, { command: 'cat big.log', exitCode: 0, output: 'x'.repeat(SHELL_OUTPUT_CHARS), include: true });
    env.gateway.script.push(textStep('First.'));
    const first = await env.enqueue('first', { history: 'fresh' });
    await env.runOnce(env.worker());
    expect([env.run(first.id).status, runProblemsOf(env.events(first.id), '')]).toEqual(['COMPLETED', []]);

    env.gateway.script.push(textStep('Second.'));
    const second = await env.enqueue('second', { history: 'inherit' });
    await env.runOnce(env.worker());

    expect([env.run(second.id).status, runProblemsOf(env.events(second.id), '')]).toEqual(['COMPLETED', []]);
    const requested = env.ofType(second.id, 'model.requested')[0]?.body;
    expect(JSON.stringify(requested).length).toBeLessThan(REQUEST_BOUND_CHARS);
  });

  it('a small user shell output of an earlier run reaches the later run whole', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8192) });
    env.store.userShell.record(env.session.id, { command: 'echo small', exitCode: 0, output: SMALL_SHELL_OUTPUT, include: true });
    env.gateway.script.push(textStep('First.'));
    await env.enqueue('first', { history: 'fresh' });
    await env.runOnce(env.worker());
    env.gateway.script.push(textStep('Second.'));
    const second = await env.enqueue('second', { history: 'inherit' });
    await env.runOnce(env.worker());

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(JSON.stringify(env.gateway.streams.at(-1)?.body)).toContain(SMALL_SHELL_OUTPUT);
  });
});
