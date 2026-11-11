import { describe, expect, it } from 'vitest';
import { startService, pollFor } from './helpers.ts';
import type { StreamEvent } from './helpers.ts';

const labelOf = (event: StreamEvent): string => (event.type === 'notice' ? String(event.message) : event.type === 'mode.changed' ? `mode:${String(event.mode)}` : event.type);

const interleaved = async () => {
  const env = await startService();
  const session = await env.createSession();
  const runA = await env.createRun(session.id, { input: 'a' });
  const runB = await env.createRun(session.id, { input: 'b' });
  const claimA = env.claimRun(runA.id, 'worker-a');
  env.append(claimA, [{ type: 'notice', level: 'info', message: 'a1' }]);
  expect((await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan' } })).status).toBe(200);
  env.append(claimA, [{ type: 'notice', level: 'info', message: 'a2' }]);
  expect((await env.store.transition(claimA, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  const claimB = env.claimRun(runB.id, 'worker-b');
  env.append(claimB, [{ type: 'notice', level: 'info', message: 'b1' }]);
  expect((await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'acceptEdits' } })).status).toBe(200);
  env.append(claimB, [{ type: 'notice', level: 'info', message: 'b2' }]);
  return { env, session, runA, runB, claimB };
};

describe('session stream', () => {
  it('delivers events of two runs and the session event in global id order with the global id as the frame id', async () => {
    const { env, session, runA, runB } = await interleaved();
    const stream = await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id' });

    const frames = await stream.until((event) => event.type === 'notice' && event.message === 'b2');

    const ids = frames.map((event) => event.id);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
    expect(new Set(ids).size).toBe(ids.length);
    expect(frames.every((event) => event.sessionId === session.id)).toBe(true);
    const labels = frames.map(labelOf).filter((label) => ['a1', 'mode:plan', 'a2', 'b1', 'mode:acceptEdits', 'b2'].includes(label));
    expect(labels).toEqual(['a1', 'mode:plan', 'a2', 'b1', 'mode:acceptEdits', 'b2']);
    expect(frames.find((event) => event.message === 'a1')?.runId).toBe(runA.id);
    expect(frames.find((event) => event.message === 'b1')?.runId).toBe(runB.id);
    const runIds = new Set(frames.filter((event) => event.runId !== undefined).map((event) => event.runId));
    expect([...runIds].sort()).toEqual([runA.id, runB.id].sort());
  });

  it('resumes after a global id from Last-Event-ID and from ?after=', async () => {
    const { env, session } = await interleaved();
    const full = await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id' });
    const all = await full.until((event) => event.type === 'notice' && event.message === 'b2');
    full.close();
    const pivot = all.findIndex((event) => event.type === 'mode.changed' && event.mode === 'acceptEdits');
    const pivotId = all[pivot]?.id;
    if (pivotId === undefined) throw new Error('mode.changed missing');

    const byHeader = await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id', headers: { 'last-event-id': String(pivotId) } });
    const resumed = await byHeader.until((event) => event.type === 'notice' && event.message === 'b2');
    expect(resumed.map((event) => event.id)).toEqual(all.slice(pivot + 1).map((event) => event.id));

    const byQuery = await env.stream(`/v1/sessions/${session.id}/events?after=${pivotId}`, { idField: 'id' });
    const resumedByQuery = await byQuery.until((event) => event.type === 'notice' && event.message === 'b2');
    expect(resumedByQuery.map((event) => event.id)).toEqual(all.slice(pivot + 1).map((event) => event.id));
  });

  it('stays open after every run is terminal and delivers later session events', async () => {
    const { env, session, runB, claimB } = await interleaved();
    await env.http('POST', `/v1/runs/${runB.id}/cancel`);
    expect((await env.store.transition(claimB, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');
    const stream = await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id' });
    await stream.until((event) => event.type === 'run.status' && event.runId === runB.id && event.to === 'CANCELLED');
    await pollFor(() => env.notifier.subscriberCount() === 1, 5000, 'the session subscriber');

    expect((await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'manual' } })).status).toBe(200);

    const later = await stream.until((event) => event.type === 'mode.changed' && event.mode === 'manual');
    expect(later.at(-1)).not.toHaveProperty('runId');
    expect(stream.ended).toBe(false);
  });

  it('answers an unknown session with 404 and a cursor above the session maximum with 400', async () => {
    const env = await startService();
    expect((await env.stream('/v1/sessions/ses_missing/events', { idField: 'id' })).status).toBe(404);
    const session = await env.createSession();
    await env.createRun(session.id);
    const max = env.store.sessionMaxEventId(session.id);
    expect((await env.stream(`/v1/sessions/${session.id}/events?after=${max + 1}`, { idField: 'id' })).status).toBe(400);
    expect((await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id', headers: { 'last-event-id': 'x' } })).status).toBe(400);
    expect((await env.stream(`/v1/sessions/${session.id}/events?after=-1`, { idField: 'id' })).status).toBe(400);
  });
});
