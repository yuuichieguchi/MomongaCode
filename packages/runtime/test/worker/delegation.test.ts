import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const write = (env: Env, callId: string, name: string, content = 'held content') => ({ callId, name: 'Write', args: { file_path: path.join(env.project, name), content } });
const echo = (callId: string, value: string) => ({ callId, name: 'Echo', args: { value } });
const shell = (callId: string, command: string) => ({ callId, name: 'Bash', args: { command } });

const mandateAsking = (env: Env, file: string) => ({ scope: { allow: ['Bash(ls:*)'], ask: [`Write(/${path.join(env.project, file)})`] } });

const textOf = (item: unknown): string => JSON.stringify(item);

describe('a run under a mandate holds a call that needs approval and goes on', () => {
  it('runs the sibling call, gives the model a placeholder for the held one, and takes the next model step without waiting', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt'), echo('call_r', 'sibling')]), textStep('Waiting for the write.'));
    const run = await env.enqueue('Write and read', { mandate: mandateAsking(env, 'out.txt') });

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const held = env.ofType(run.id, 'tool.held');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ callId: env.gateway.callId('call_w'), footprint: { reads: [], writes: [`local:${path.join(env.project, 'out.txt')}`] } });
    const completions = env.ofType(run.id, 'tool.completed');
    expect(completions.find((event) => event.callId === env.gateway.callId('call_r'))).toMatchObject({ status: 'completed' });
    const placeholder = completions.find((event) => event.callId === env.gateway.callId('call_w'));
    expect(placeholder).toMatchObject({ status: 'failed', denial: { source: 'held' } });
    expect(placeholder?.output).toBe(`Not run yet: waiting for a person to approve (${held[0]?.approvalId}). Do not repeat or rephrase this call. Continue with work that does not depend on it; its result will be shown to you when it has run.`);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(2);
    expect(fs.existsSync(path.join(env.project, 'out.txt'))).toBe(false);
    expect(env.store.approvals.listPending(run.id).map((approval) => approval.id)).toEqual([held[0]?.approvalId]);
    expect(env.ofType(run.id, 'tool.permission.requested')[0]?.options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once']);
  });

  it('does not complete on a final answer while a call is held: it reports why it waits and waits for a person', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt')]), textStep('Done except the write.'));
    const run = await env.enqueue('Write', { mandate: mandateAsking(env, 'out.txt') });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const [quiescent] = env.ofType(run.id, 'run.quiescent');
    expect(quiescent?.held).toEqual([expect.objectContaining({ callId: env.gateway.callId('call_w'), tool: 'Write', reason: expect.stringContaining('approval required by rule') })]);
    expect(env.fold(run.id).notes.some((note) => note.code === 'run_quiescent' && note.message.startsWith('The run waits for a person: 1 call held for approval, and nothing else can proceed.'))).toBe(true);
    expect(env.fold(run.id).quiescent).toBe(true);
  });

  it('runs the approved call once, shows its late result to the model, and completes', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt', 'approved content')]), textStep('Done except the write.'), textStep('All done.'));
    const run = await env.enqueue('Write', { mandate: mandateAsking(env, 'out.txt') });
    await env.runOnce(env.worker());

    await env.resolveApproval(run.id, 'allow_once');
    expect(env.run(run.id).status).toBe('QUEUED');
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(path.join(env.project, 'out.txt'), 'utf8')).toBe('approved content');
    const resolved = env.ofType(run.id, 'tool.held.resolved');
    expect(resolved).toEqual([expect.objectContaining({ callId: env.gateway.callId('call_w'), outcome: 'executed', status: 'completed' })]);
    const state = env.fold(run.id);
    expect(state.heldCalls).toEqual({});
    const late = state.history.filter((entry) => textOf(entry.item).includes('late_tool_result'));
    expect(late).toHaveLength(1);
    expect(textOf(late[0]?.item)).toContain('a person approved it and it has now run');
    expect(env.ofType(run.id, 'tool.completed').filter((event) => event.callId === env.gateway.callId('call_w'))).toHaveLength(1);
    const lastBody = JSON.stringify(env.ofType(run.id, 'model.requested').at(-1)?.body);
    expect(lastBody).toContain('late_tool_result');
  });

  it('does not run a rejected call, and tells the model so in a late result', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt')]), textStep('Done except the write.'), textStep('Understood.'));
    const run = await env.enqueue('Write', { mandate: mandateAsking(env, 'out.txt') });
    await env.runOnce(env.worker());

    await env.resolveApproval(run.id, 'reject_once');
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.existsSync(path.join(env.project, 'out.txt'))).toBe(false);
    expect(env.ofType(run.id, 'tool.held.resolved')).toEqual([expect.objectContaining({ outcome: 'rejected', status: 'failed', output: 'A person rejected this call, so it was not run.' })]);
  });

  it('blocks a later call that touches what the held call writes, without asking, and runs one that does not', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      callsStep([write(env, 'call_w', 'out.txt')]),
      callsStep([shell('call_same', 'cat out.txt'), echo('call_other', 'elsewhere')]),
      textStep('Waiting.'),
    );
    const run = await env.enqueue('Write then read', { mandate: mandateAsking(env, 'out.txt') });

    await env.runOnce(env.worker());

    const completions = env.ofType(run.id, 'tool.completed');
    const blocked = completions.find((event) => event.callId === env.gateway.callId('call_same'));
    expect(blocked).toMatchObject({ status: 'failed', denial: { source: 'held' } });
    expect(blocked?.output).toContain(`blocked by the held call ${env.gateway.callId('call_w')} (same path or ref)`);
    expect(completions.find((event) => event.callId === env.gateway.callId('call_other'))).toMatchObject({ status: 'completed' });
    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
  });
});

describe('a call outside the mandate is not run and not asked about', () => {
  it('denies it with the reason, and the same call without a mandate asks as today', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'other.txt')]), textStep('I could not write it.'));
    const run = await env.enqueue('Write', { mandate: { scope: { allow: ['Read'] } } });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed).toMatchObject({ status: 'failed', denial: { source: 'mandate' } });
    expect(completed?.output).toContain('outside the declared mandate');
    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.ofType(run.id, 'tool.held')).toEqual([]);

    const plain = await makeEnv();
    plain.gateway.script.push(callsStep([write(plain, 'call_w', 'other.txt')]));
    const asked = await plain.enqueue('Write');
    await plain.runOnce(plain.worker());
    expect(plain.run(asked.id).status).toBe('WAITING_HUMAN');
    expect(plain.ofType(asked.id, 'tool.held')).toEqual([]);
  });

  it('pins the scope and the hold of the mandate at the start of the run', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello', { mandate: { scope: { allow: ['Read'], deny: ['Bash(rm:*)'] }, hold: { onQuiescent: 'wait' } } });

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'run.started')[0]?.pins['mandate']).toMatchObject({ scope: { allow: ['Read'], deny: ['Bash(rm:*)'] }, hold: { onQuiescent: 'wait' } });
  });
});

describe('a run that ends with a call still held', () => {
  it('withdraws the approval when the run is cancelled', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([write(env, 'call_w', 'out.txt')]), textStep('Done except the write.'));
    const run = await env.enqueue('Write', { mandate: mandateAsking(env, 'out.txt') });
    await env.runOnce(env.worker());

    await env.cancelToEnd(run.id);

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(fs.existsSync(path.join(env.project, 'out.txt'))).toBe(false);
  });
});
