import { describe, expect, it } from 'vitest';
import { createChildRuns } from '../../src/process/child-runs.ts';
import { OTHER_MODEL_ID, startService } from './helpers.ts';

describe('the reasoning effort of a session on the Run API', () => {
  it('is absent until chosen, is set at creation and by PATCH, and PATCH null unsets it', async () => {
    const env = await startService();
    const plain = await env.createSession();
    expect(plain).not.toHaveProperty('effort');
    const chosen = await env.createSession({ effort: 'high' });
    expect(chosen.effort).toBe('high');
    expect((await env.http('PATCH', `/v1/sessions/${plain.id}`, { body: { effort: 'low' } })).json.session.effort).toBe('low');
    expect((await env.http('PATCH', `/v1/sessions/${plain.id}`, { body: { effort: null } })).json.session).not.toHaveProperty('effort');
    expect((await env.http('PATCH', `/v1/sessions/${plain.id}`, { body: { effort: 'huge' } })).status).toBe(400);
  });

  it('keeps no level of the settings on the session, so a level saved later for its model or models.effort applies from the next run', async () => {
    const env = await startService();
    expect(await env.createSession()).not.toHaveProperty('effort');
    expect((await env.createSession({ effort: 'high' })).effort).toBe('high');
  });

  it('drops the level chosen for the session when the model changes, and keeps one sent with the change', async () => {
    const env = await startService();
    const session = await env.createSession({ effort: 'high' });
    const switched = (await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: OTHER_MODEL_ID } })).json.session;
    expect(switched.model).toBe(OTHER_MODEL_ID);
    expect(switched).not.toHaveProperty('effort');
    const both = (await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: session.model, effort: 'low' } })).json.session;
    expect(both).toMatchObject({ model: session.model, effort: 'low' });
    const same = (await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: session.model } })).json.session;
    expect(same.effort).toBe('low');
  });

  it('gives a child the effort of its definition, else the effort its parent run pinned, and serves both with the model on the child session', async () => {
    const env = await startService();
    const session = await env.createSession({ effort: 'medium' });
    const run = await env.createRun(session.id);
    env.append(env.claimRun(run.id), [{ type: 'run.started', attempt: 1, now: 1, pins: { model: session.model, effort: 'medium' }, mode: 'manual' }]);
    const children = createChildRuns({ store: env.store, listing: async () => ({ models: [], views: [] }) });
    const inherited = await children.spawn({ parentRunId: run.id, parentCallId: 'call-1', agent: { name: 'a', description: 'd', prompt: 'p', scope: 'builtin' }, prompt: 'x' });
    const own = await children.spawn({ parentRunId: run.id, parentCallId: 'call-2', agent: { name: 'b', description: 'd', prompt: 'p', scope: 'builtin', effort: 'xhigh' }, prompt: 'x' });
    const inheritedView = (await env.http('GET', `/v1/sessions/${inherited.sessionId}`)).json.session;
    expect(inheritedView).toMatchObject({ model: session.model, effort: 'medium' });
    expect((await env.http('GET', `/v1/sessions/${own.sessionId}`)).json.session.effort).toBe('xhigh');
  });
});
