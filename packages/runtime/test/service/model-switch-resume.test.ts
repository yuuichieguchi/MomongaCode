import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { callsStep, textStep } from '../worker/scripts.ts';
import { OTHER_MODEL_ID, attachWorkerKit, startService } from './helpers.ts';
import { fakeViewsOf } from '../worker/fake-gateway.ts';

describe('a model switch through PATCH while a run waits for approval', () => {
  it('lets the run resume on the model it pinned', async () => {
    const env = await startService();
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    const target = path.join(env.layout.projectReal, 'out.txt');
    kit.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'approved' } }]), textStep('Written.'));
    const run = await env.createRun(session.id, { input: 'Write the file' });
    expect(await kit.runOnce(kit.worker('worker-1'))).toBe('yielded');
    const [approval] = (await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals;

    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: OTHER_MODEL_ID } });
    expect(patched.status).toBe(200);
    const option = approval.options.find((candidate: { kind: string }) => candidate.kind === 'allow_once');
    expect((await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: option.optionId } })).status).toBe(200);
    await kit.runOnce(kit.worker('worker-2'));

    expect(env.store.getRun(run.id)?.status).toBe('COMPLETED');
    expect(kit.gateway.streams.map((stream) => stream.body.model)).toEqual([session.model, session.model]);
    const starts = env.ofType(run.id, 'run.started');
    expect(starts[1]?.pins).toEqual(starts[0]?.pins);
  });

  it('starts the subagent the task spawns after the switch on the model the task pinned', async () => {
    const env = await startService();
    const kit = attachWorkerKit(env);
    const directory = path.join(env.layout.projectReal, '.momonga', 'agents');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'reviewer.md'), '---\nname: reviewer\ndescription: reviews code\n---\nYou review code.\n');
    const agents = (): AgentsPort =>
      createAgentsPort({
        home: env.layout.home,
        fileSystem: createNodeSkillFileSystem(),
        settings: { trusted: async () => true, approvedProjectAgents: async () => ({ has: () => true }) },
        runs: createChildRuns({ store: env.store, listing: async () => ({ models: [], views: fakeViewsOf([session.model, OTHER_MODEL_ID]) }) }),
      });
    const session = await env.createSession();
    const target = path.join(env.layout.projectReal, 'out.txt');
    kit.gateway.script.push(
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'approved' } }]),
      callsStep([{ callId: 'call_a_1', name: 'Agent', args: { description: 'review', prompt: 'Look at the diff', subagent_type: 'reviewer' } }]),
    );
    const run = await env.createRun(session.id, { input: 'Write then review' });
    expect(await kit.runOnce(kit.worker('worker-1', { agents: agents() }))).toBe('yielded');
    const [approval] = (await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals;

    expect((await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: OTHER_MODEL_ID } })).status).toBe(200);
    const option = approval.options.find((candidate: { kind: string }) => candidate.kind === 'allow_once');
    expect((await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: option.optionId } })).status).toBe(200);
    await kit.runOnce(kit.worker('worker-2', { agents: agents() }));

    const [child] = env.store.listChildRuns(run.id);
    if (child === undefined) throw new Error('the task did not spawn a subagent');
    expect(env.store.getSession(session.id)?.model).toBe(OTHER_MODEL_ID);
    expect(env.store.getSession(child.sessionId)?.model).toBe(session.model);
  });
});
