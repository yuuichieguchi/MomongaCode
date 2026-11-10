import { describe, expect, it } from 'vitest';
import { expectError, expectSchema, startService } from './helpers.ts';

const spawnChild = async (env: Awaited<ReturnType<typeof startService>>) => {
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  env.claimRun(run.id);
  const created = env.store.createChildRun({ parentRunId: run.id, parentCallId: 'call-1', input: 'child task', pins: { agent: { name: 'helper', description: 'd', prompt: 'p' } }, model: 'fm' });
  if (created.kind !== 'created') throw new Error('expected a child');
  return { session, run, child: created.run, childSession: created.session };
};

describe('subagent runs on the Run API', () => {
  it('shows the parent link and the agent name on the run view and lists the children of a run', async () => {
    const env = await startService();
    const { run, child } = await spawnChild(env);
    const view = (await env.http('GET', `/v1/runs/${child.id}`)).json.run;
    expectSchema('RunView', view);
    expect(view).toMatchObject({ id: child.id, parentRunId: run.id, parentCallId: 'call-1', agent: 'helper', history: 'fresh' });
    const parentView = (await env.http('GET', `/v1/runs/${run.id}`)).json.run;
    expect(parentView).toMatchObject({ parentRunId: null, parentCallId: null });
    expect(parentView.agent).toBeUndefined();

    const children = await env.http('GET', `/v1/runs/${run.id}/children`);
    expect(children.status).toBe(200);
    expectSchema('ChildRunsResponse', children.json);
    expect(children.json.runs.map((entry: { id: string }) => entry.id)).toEqual([child.id]);
    expect((await env.http('GET', `/v1/runs/${child.id}/children`)).json).toEqual({ runs: [] });
    expectError(await env.http('GET', '/v1/runs/missing/children'), 404);
  });

  it('streams the events of a child run on its own run endpoint', async () => {
    const env = await startService();
    const { child } = await spawnChild(env);
    const stream = await env.stream(`/v1/runs/${child.id}/events?after=0`);
    const first = await stream.next();
    expect(first).toMatchObject({ type: 'user.message', text: 'child task', runId: child.id });
    stream.close();
  });

  it('keeps child sessions out of the session list and refuses direct requests to them', async () => {
    const env = await startService();
    const { session, childSession } = await spawnChild(env);
    const listed = (await env.http('GET', '/v1/sessions')).json.sessions.map((entry: { id: string }) => entry.id);
    expect(listed).toEqual([session.id]);
    expect((await env.http('GET', `/v1/sessions/${childSession.id}`)).status).toBe(200);
    expectError(await env.http('PATCH', `/v1/sessions/${childSession.id}`, { body: { permissionMode: 'acceptEdits' } }), 409, 'child_session');
    expectError(await env.http('POST', `/v1/sessions/${childSession.id}/runs`, { body: { input: 'hi' } }), 409, 'child_session');
  });

  it('cancels the children with the parent through the cancel endpoint', async () => {
    const env = await startService();
    const { run, child } = await spawnChild(env);
    expect((await env.http('POST', `/v1/runs/${run.id}/cancel`)).status).toBe(202);
    expect(env.store.getRun(child.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    expect(await env.store.finishCancelled(() => undefined)).toEqual(expect.arrayContaining([child.id]));
    expect((await env.getRun(child.id)).status).toBe('CANCELLED');
  });

  it('lists the background jobs of a session, including those of its subagents', async () => {
    const env = await startService();
    const { session, run, childSession, child } = await spawnChild(env);
    env.store.jobs.start({ id: 'bash_aaaaaaaaaaaa', idemKey: 'a'.repeat(64), sessionId: childSession.id, runId: child.id, callId: 'c', command: 'sleep 30' });
    env.store.jobs.finish('bash_aaaaaaaaaaaa', { status: 'exited', exitCode: 1 });
    const response = await env.http('GET', `/v1/sessions/${session.id}/jobs`);
    expect(response.status).toBe(200);
    expectSchema('JobsResponse', response.json);
    expect(response.json.jobs).toMatchObject([{ id: 'bash_aaaaaaaaaaaa', sessionId: session.id, runId: child.id, status: 'exited', exitCode: 1, command: 'sleep 30' }]);
    expect(run.id).toBeDefined();
    expectError(await env.http('GET', '/v1/sessions/missing/jobs'), 404);
  });
});
