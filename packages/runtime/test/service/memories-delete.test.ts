import { describe, expect, it } from 'vitest';
import { startService } from './helpers.ts';

describe('DELETE /v1/memories/:id retires the note', () => {
  it('DELETE answers 204 and the note stays in history', async () => {
    const env = await startService({ fakeTimers: true });
    const note = env.store.memories.addByCommand({ scope: 'user', project: null, text: 'prefers tabs', evidence: [] });
    const removed = await env.http('DELETE', `/v1/memories/${note.id}`);
    expect(removed.status).toBe(204);
    expect(env.store.memories.get(note.id)?.text).toBe('prefers tabs');
    const history = await env.http('GET', `/v1/memories/${note.id}/history`);
    expect(history.status).toBe(200);
    expect(history.json.memories.map((entry: { id: string; retiredAt: number | null }) => [entry.id, entry.retiredAt !== null])).toEqual([[note.id, true]]);
    expect((await env.http('GET', '/v1/memories')).json.memories).toEqual([]);
  });

  it('a second delete is a no-op that still answers 204', async () => {
    const env = await startService({ fakeTimers: true });
    const note = env.store.memories.addByCommand({ scope: 'user', project: null, text: 'prefers tabs', evidence: [] });
    expect((await env.http('DELETE', `/v1/memories/${note.id}`)).status).toBe(204);
    const retiredAt = env.store.memories.get(note.id)?.retiredAt;
    expect(retiredAt).toEqual(expect.any(Number));
    expect((await env.http('DELETE', `/v1/memories/${note.id}`)).status).toBe(204);
    expect(env.store.memories.get(note.id)?.retiredAt).toBe(retiredAt);
  });
});
