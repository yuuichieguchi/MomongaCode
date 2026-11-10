import { describe, expect, it } from 'vitest';
import { INBOX_MAX_PENDING } from '@momonga/protocol';
import { callsStep, textStep } from '../worker/scripts.ts';
import { DEFAULT_LIMITS, DEFAULT_TIMEOUT_MS, attachWorkerKit, expectError, expectSchema, startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const IMAGE = { mediaType: 'image/png', data: Buffer.from('fake png bytes').toString('base64') };

const addMessage = async (env: ServiceEnv, sessionId: string, delivery: 'steer' | 'queue', text: string) => {
  const response = await env.http('POST', `/v1/sessions/${sessionId}/inbox`, { body: { delivery, text } });
  if (response.status !== 201) throw new Error(`inbox add failed with ${response.status}: ${response.text}`);
  expectSchema('InboxAddResponse', response.json);
  return response.json;
};

const pendingOf = async (env: ServiceEnv, sessionId: string): Promise<string[]> => {
  const response = await env.http('GET', `/v1/sessions/${sessionId}/inbox`);
  expect(response.status).toBe(200);
  expectSchema('InboxResponse', response.json);
  return response.json.pending.map((row: { delivery: string; text: string }) => `${row.delivery}:${row.text}`);
};

const userTexts = (env: ServiceEnv, runId: string) =>
  env.ofType(runId, 'user.message').map((event) => ({ text: event.text, ...(event.source === undefined ? {} : { source: event.source }) }));

const userInputsOf = (body: { input?: unknown }): string[] =>
  (Array.isArray(body.input) ? body.input : []).flatMap((item: { type?: string; role?: string; content?: unknown }) =>
    item.type === 'message' && item.role === 'user' ? [JSON.stringify(item.content)] : [],
  );

describe('the run inbox routes (design 5.3)', () => {
  it('adds a message behind a working run, lists it, and takes it back once', async () => {
    const env = await startService();
    const session = await env.createSession();
    await env.createRun(session.id);

    const added = await addMessage(env, session.id, 'queue', 'then the docs');

    expect(added.row).toMatchObject({ sessionId: session.id, delivery: 'queue', text: 'then the docs', seq: 1, state: 'pending', settledAt: null });
    expect(added.pending).toEqual([added.row]);
    expect(await pendingOf(env, session.id)).toEqual(['queue:then the docs']);

    const taken = await env.http('POST', `/v1/inbox/${added.row.id}/withdraw`);
    expect(taken.status).toBe(200);
    expectSchema('InboxWithdrawResponse', taken.json);
    expect(taken.json).toMatchObject({ outcome: 'withdrawn', row: { id: added.row.id, state: 'withdrawn' }, pending: [] });
    expect(await pendingOf(env, session.id)).toEqual([]);
  });

  it('answers 404 for an unknown session and an unknown row, and 400 for a body outside the schema', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', '/v1/sessions/nope/inbox', { body: { delivery: 'queue', text: 'x' } }), 404, 'not_found');
    expectError(await env.http('GET', '/v1/sessions/nope/inbox'), 404, 'not_found');
    expectError(await env.http('POST', '/v1/inbox/nope/withdraw'), 404, 'not_found');
    expectError(await env.http('GET', '/v1/runs/nope/successor'), 404, 'not_found');
    expectError(await env.http('POST', `/v1/sessions/${session.id}/inbox`, { body: { delivery: 'interrupt', text: 'x' } }), 400, 'invalid_request');
    expectError(await env.http('POST', `/v1/sessions/${session.id}/inbox`, { body: { delivery: 'queue', text: '' } }), 400, 'invalid_request');
  });

  it(`refuses the message after ${INBOX_MAX_PENDING} waiting ones with 409 inbox_full and the sentence of the hint row`, async () => {
    const env = await startService();
    const session = await env.createSession();
    await env.createRun(session.id);
    for (let index = 0; index < INBOX_MAX_PENDING; index += 1) await addMessage(env, session.id, 'queue', `m${index}`);

    const refused = await env.http('POST', `/v1/sessions/${session.id}/inbox`, { body: { delivery: 'steer', text: 'one more' } });

    expectError(refused, 409, 'inbox_full');
    expect(refused.json.error.message).toBe('20 messages are already waiting');
    expect(await pendingOf(env, session.id)).toHaveLength(INBOX_MAX_PENDING);
  });

  it('refuses images when the model alias does not declare image input, and stores them when it does', async () => {
    const refusing = await startService({ imageInput: false });
    const refusedSession = await refusing.createSession();
    await refusing.createRun(refusedSession.id);
    const refused = await refusing.http('POST', `/v1/sessions/${refusedSession.id}/inbox`, { body: { delivery: 'queue', text: 'look', images: [IMAGE] } });
    expectError(refused, 422, 'image_input_unsupported');
    expect(await pendingOf(refusing, refusedSession.id)).toEqual([]);

    const env = await startService({ imageInput: true });
    const session = await env.createSession();
    await env.createRun(session.id);
    const response = await env.http('POST', `/v1/sessions/${session.id}/inbox`, { body: { delivery: 'queue', text: 'look', images: [IMAGE] } });
    expect(response.status).toBe(201);
    expect(response.json.row.images).toEqual([{ mediaType: 'image/png', byteLength: Buffer.from('fake png bytes').length }]);
    expect(JSON.stringify(response.json)).not.toContain(IMAGE.data);
    expect(env.store.inbox.list(session.id)[0]?.images).toEqual([IMAGE]);
  });

  it('refuses a message while the service drains', async () => {
    const env = await startService();
    const session = await env.createSession();
    await env.createRun(session.id);
    env.service.beginDraining();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/inbox`, { body: { delivery: 'queue', text: 'x' } }), 503, 'draining');
  });

  it('starts a message at once as a run with the service defaults when no run of the session is open', async () => {
    const env = await startService();
    const session = await env.createSession();

    const added = await addMessage(env, session.id, 'queue', 'nobody runs');

    expect(added).toMatchObject({ row: { state: 'delivered' }, pending: [] });
    const [run] = env.store.listRuns(session.id);
    expect(run).toMatchObject({ status: 'QUEUED', limits: DEFAULT_LIMITS, deadlineAt: env.clock.now() + DEFAULT_TIMEOUT_MS });
    expect(userTexts(env, run?.id ?? '')).toEqual([{ text: 'nobody runs', source: 'queue' }]);
  });
});

describe('delivery by the worker and at the end of a run', () => {
  it('gives a steering message to the model after the tool call of the step, as a user message before the next request', async () => {
    const env = await startService();
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    kit.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'a' } }]), textStep('Done.'));
    kit.toolbox.hooks['Echo'] = async () => {
      await addMessage(env, session.id, 'steer', 'also update the docs');
      await addMessage(env, session.id, 'queue', 'then release');
    };
    const run = await env.createRun(session.id, { input: 'fix the bug' });

    expect(await kit.runOnce(kit.worker())).toBe('yielded');

    expect((await env.getRun(run.id)).status).toBe('COMPLETED');
    expect(userTexts(env, run.id)).toEqual([{ text: 'fix the bug' }, { text: 'also update the docs', source: 'steer' }]);
    const types = env.runEvents(run.id).map((event) => event.type);
    const steeredAt = env.runEvents(run.id).findIndex((event) => event.type === 'user.message' && event.source === 'steer');
    expect(types.lastIndexOf('tool.completed')).toBeLessThan(steeredAt);
    expect(types.lastIndexOf('model.requested')).toBeGreaterThan(steeredAt);
    expect(userInputsOf(kit.gateway.streams[0]?.body ?? {}).some((content) => content.includes('also update the docs'))).toBe(false);
    const second = userInputsOf(kit.gateway.streams[1]?.body ?? {});
    expect(second.filter((content) => content.includes('also update the docs'))).toHaveLength(1);
    expect(second.at(-1)).toBe(JSON.stringify([{ type: 'input_text', text: 'also update the docs' }]));

    const successor = await env.http('GET', `/v1/runs/${run.id}/successor`);
    expectSchema('RunSuccessorResponse', successor.json);
    expect(successor.json.successor).toMatchObject({ status: 'QUEUED', previousRunId: run.id, ordinal: 2 });
    expect(userTexts(env, successor.json.successor.id)).toEqual([{ text: 'then release', source: 'queue' }]);
    expect(await pendingOf(env, session.id)).toEqual([]);

    kit.gateway.script.push(textStep('Released.'));
    expect(await kit.runOnce(kit.worker('w2'))).toBe('yielded');
    expect((await env.getRun(successor.json.successor.id)).status).toBe('COMPLETED');
    expect((await env.http('GET', `/v1/runs/${successor.json.successor.id}/successor`)).json).toEqual({ successor: null });
  });

  it('sends a steering message as the next run when the run gives its final answer with no further tool call', async () => {
    const env = await startService();
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    kit.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'a' } }]), textStep('Done.'));
    const run = await env.createRun(session.id, { input: 'fix the bug' });
    let requests = 0;
    kit.toolbox.hooks['Echo'] = async () => {
      requests += 1;
    };
    const worker = kit.worker();
    const original = env.store.transition.bind(env.store);
    env.store.transition = async (claim, from, to, patch, preceding) => {
      if (to === 'COMPLETED') await addMessage(env, session.id, 'steer', 'too late to steer');
      return original(claim, from, to, patch, preceding);
    };

    expect(await kit.runOnce(worker)).toBe('yielded');

    expect(requests).toBe(1);
    expect(userTexts(env, run.id)).toEqual([{ text: 'fix the bug' }]);
    const next = (await env.http('GET', `/v1/runs/${run.id}/successor`)).json.successor;
    expect(userTexts(env, next.id)).toEqual([{ text: 'too late to steer', source: 'queue' }]);
  });

  it('starts the first waiting message as a run when the working run is cancelled, and keeps the rest waiting in order', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    await addMessage(env, session.id, 'steer', 'instead do this');
    await addMessage(env, session.id, 'queue', 'and then that');

    expect((await env.http('POST', `/v1/runs/${run.id}/cancel`)).status).toBe(202);
    expect((await env.store.transition(claim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');

    const next = (await env.http('GET', `/v1/runs/${run.id}/successor`)).json.successor;
    expect(next).toMatchObject({ status: 'QUEUED' });
    expect(userTexts(env, next.id)).toEqual([{ text: 'instead do this', source: 'queue' }]);
    expect(await pendingOf(env, session.id)).toEqual(['queue:and then that']);
  });

  it('starts the queued message when the working run fails', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    await addMessage(env, session.id, 'queue', 'after the failure');

    expect((await env.store.transition(claim, ['RUNNING'], 'FAILED', { error: { code: 'x', message: 'y' } })).kind).toBe('ok');

    const next = (await env.http('GET', `/v1/runs/${run.id}/successor`)).json.successor;
    expect(userTexts(env, next.id)).toEqual([{ text: 'after the failure', source: 'queue' }]);
  });

  it('delivers a steering message that waited through a lost worker when another worker takes the run', async () => {
    const env = await startService();
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'fix the bug' });
    env.claimRun(run.id, 'lost-worker');
    await addMessage(env, session.id, 'steer', 'survives the restart');
    env.clock.advance(60_000);
    kit.gateway.script.push(textStep('Done.'));

    expect(await kit.runOnce(kit.worker('w2'))).toBe('yielded');

    expect((await env.getRun(run.id)).status).toBe('COMPLETED');
    expect(userTexts(env, run.id)).toEqual([{ text: 'fix the bug' }, { text: 'survives the restart', source: 'steer' }]);
    expect(userInputsOf(kit.gateway.streams[0]?.body ?? {}).at(-1)).toBe(JSON.stringify([{ type: 'input_text', text: 'survives the restart' }]));
  });

  it('sends inbox.changed with the rows pending after each change on the session stream', async () => {
    const env = await startService();
    const session = await env.createSession();
    await env.createRun(session.id);
    const added = await addMessage(env, session.id, 'queue', 'one');
    await env.http('POST', `/v1/inbox/${added.row.id}/withdraw`);
    const changes = env.store.readSessionEvents(session.id, 0, 100).flatMap((event) => (event.type === 'inbox.changed' ? [event.pending.map((row) => row.text)] : []));
    expect(changes).toEqual([['one'], []]);
    for (const event of env.store.readSessionEvents(session.id, 0, 100)) if (event.type === 'inbox.changed') expectSchema('PublicRunEvent', event);
  });
});
