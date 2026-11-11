import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPublicRunEvent } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import type { ResultOutcome } from '@momonga/tools';
import { outcomePayloads } from '../../src/worker/tool-step.ts';
import { mandateNotice } from '../../src/worker/held-calls.ts';
import { LEASE_MS, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const write = (env: Env, callId: string, name: string, content = 'held content') => ({ callId, name: 'Write', args: { file_path: path.join(env.project, name), content } });
const echo = (callId: string, value: string) => ({ callId, name: 'Echo', args: { value } });
const shell = (callId: string, command: string) => ({ callId, name: 'Bash', args: { command } });

const mandateAsking = (env: Env, file: string) => ({ scope: { allow: ['Bash(ls:*)', 'Bash(cat:*)'], ask: [`Write(/${path.join(env.project, file)})`], deny: ['Bash(rm:*)'] } });

describe('a run under a mandate is quiescent when every call the model tries is blocked', () => {
  it('reports why it waits and waits for a person instead of asking the model again, then goes on when the held call is decided', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt', 'approved content')]), callsStep([shell('call_same', 'cat out.txt')]), textStep('All done.'));
    const run = await env.enqueue('Write then read', { mandate: mandateAsking(env, 'out.txt') });

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(2);
    const [quiescent] = env.ofType(run.id, 'run.quiescent');
    expect(quiescent?.held).toEqual([expect.objectContaining({ callId: env.gateway.callId('call_w'), tool: 'Write' })]);
    const blocked = env.ofType(run.id, 'tool.completed').find((event) => event.callId === env.gateway.callId('call_same'));
    expect(blocked).toMatchObject({ status: 'failed', denial: { source: 'held' } });
    expect(env.fold(run.id).quiescent).toBe(true);

    await env.resolveApproval(run.id, 'allow_once');
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.held.resolved')).toEqual([expect.objectContaining({ outcome: 'executed', status: 'completed' })]);
    expect(env.ofType(run.id, 'run.quiescent')).toHaveLength(1);
  });

  it('takes the next model step when one call of the response ran beside the blocked one', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt')]), callsStep([shell('call_same', 'cat out.txt'), echo('call_other', 'elsewhere')]), textStep('Waiting.'));
    const run = await env.enqueue('Write then read', { mandate: mandateAsking(env, 'out.txt') });

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.requested')).toHaveLength(3);
  });
});

describe('a worker that stops right after the approval of a held call was recorded', () => {
  it('leaves a hold, not a blocking approval: the next worker takes the next model step with the placeholder and one approval is pending', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt'), echo('call_r', 'sibling')]), textStep('Waiting for the write.'));
    const run = await env.enqueue('Write and read', { mandate: mandateAsking(env, 'out.txt') });
    const stopsAfterApproval = new Proxy(env.store, {
      get: (target, property, receiver) => {
        if (property !== 'requestApproval') return Reflect.get(target, property, receiver) as unknown;
        return async (...args: Parameters<typeof target.requestApproval>) => {
          await target.requestApproval(...args);
          env.clock.advance(LEASE_MS + 1);
          return { kind: 'lease_lost' as const };
        };
      },
    });

    await env.runOnce(env.worker('worker-1', { store: stopsAfterApproval }));

    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.held')).toHaveLength(1);

    await env.runOnce(env.worker('worker-2'));

    expect(env.ofType(run.id, 'tool.held')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.completed').filter((event) => event.callId === env.gateway.callId('call_w'))).toEqual([expect.objectContaining({ status: 'failed', denial: expect.objectContaining({ source: 'held' }) })]);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(2);
    expect(env.ofType(run.id, 'run.quiescent')).toHaveLength(1);
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.store.approvals.listPending(run.id)).toHaveLength(1);

    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('All done.'));
    await env.runOnce(env.worker('worker-3'));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.held.resolved')).toEqual([expect.objectContaining({ outcome: 'executed', status: 'completed' })]);
  });
});

describe('the model is told its mandate', () => {
  it('in a context item of every model request of the run, and in no request of a run without a mandate', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([echo('call_r', 'one')]), textStep('Done.'));
    const run = await env.enqueue('Echo', { mandate: mandateAsking(env, 'out.txt') });
    await env.runOnce(env.worker());

    const bodies = env.ofType(run.id, 'model.requested').map((event) => JSON.stringify(event.body));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain('This run works under a mandate that was declared before it started.');
      expect(body).toContain('Bash(ls:*)');
      expect(body).toContain('Bash(rm:*)');
      expect(body).toContain('These operations are always held for a person: PullRequestMerge.');
      expect(body).toContain('git add: GitStage');
    }

    const plain = await makeEnv();
    plain.gateway.script.push(textStep('Done.'));
    const without = await plain.enqueue('Say done');
    await plain.runOnce(plain.worker());
    expect(JSON.stringify(plain.ofType(without.id, 'model.requested')[0]?.body)).not.toContain('works under a mandate');
  });

  it('names the allowed, the held and the forbidden rules, the operations always held, and the operations that replace shell commands', () => {
    const text = mandateNotice(
      { scope: { allow: ['GitCommit'], ask: ['GitPush(origin:main)'], deny: [] } },
      { alwaysOperations: ['PullRequestMerge'], supersededForms: [{ operation: 'GitStage', argv: ['git', 'add'] }] },
    );
    expect(text.split('\n')).toEqual([
      'This run works under a mandate that was declared before it started. No person is watching it.',
      'Calls these rules allow are run without asking:',
      '  GitCommit',
      'Calls these rules name wait for a person. Such a call is held: the run goes on, and its result is shown to you when it has run:',
      '  GitPush(origin:main)',
      'These operations are always held for a person: PullRequestMerge.',
      'Calls these rules name are never run:',
      '  (none)',
      'Any other call that would need approval is outside the mandate and is not run.',
      'Use the operation instead of the shell command it replaces:',
      '  git add: GitStage',
      'When a call is held or blocked, do not repeat or rephrase it. Continue with work that does not depend on it. When nothing else can be done, say what waits and stop.',
    ]);
  });
});

describe('the observed effect of an operation is recorded with its result', () => {
  const effect = { operation: 'GitPush', target: 'feature/x', outcome: 'applied' } as const;

  it('on tool.completed', () => {
    const outcome: ResultOutcome = { callId: 'c1', kind: 'result', result: { status: 'completed', output: 'pushed', effect } };
    expect(outcomePayloads(outcome)).toEqual([{ type: 'tool.completed', callId: 'c1', status: 'completed', output: 'pushed', effect }]);
  });

  it('on tool.reconciled, as already applied and as unknown', () => {
    const applied: ResultOutcome = { callId: 'c1', kind: 'result', result: { status: 'completed', output: 'pushed', effect: { ...effect, outcome: 'already_applied' } }, reconciled: 'already_applied' };
    expect(outcomePayloads(applied)).toEqual([{ type: 'tool.reconciled', callId: 'c1', outcome: 'already_applied', output: 'pushed', effect: { ...effect, outcome: 'already_applied' } }]);
    const unknown: ResultOutcome = { callId: 'c1', kind: 'result', result: { status: 'failed', output: 'unknown', effect: { ...effect, outcome: 'unknown' } }, reconciled: 'unknown' };
    expect(outcomePayloads(unknown)).toEqual([{ type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'unknown', effect: { ...effect, outcome: 'unknown' } }]);
  });

  it('is kept by the journal and reaches a client in the public event', async () => {
    const env = await makeEnv();
    const effecting = defineTool<Record<string, unknown>>({
      name: 'Effecting',
      description: 'Report an observed effect',
      kind: 'read',
      sideEffect: 'read_only',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 60_000,
      title: () => 'Effecting',
      subject: () => ({ kind: 'none', tool: 'Effecting' }),
      execute: async () => ({ status: 'completed', output: 'pushed', effect }),
    });
    env.gateway.script.push(callsStep([{ callId: 'call_e', name: 'Effecting', args: {} }]), textStep('Done.'));
    const run = await env.enqueue('Push');

    await env.runOnce(env.worker('worker-1', { toolList: () => [...env.toolbox.tools(), effecting] }));

    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed).toMatchObject({ status: 'completed', effect });
    expect(completed === undefined ? undefined : toPublicRunEvent(completed)).toMatchObject({ type: 'tool.completed', effect });
  });
});
