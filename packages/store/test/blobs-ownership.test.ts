import { describe, expect, it } from 'vitest';
import { harness, mustRun, newSession, enqueue } from './helpers.ts';

const LINES = { lineStart: 1, lineEnd: 10 };

const runIn = (store: ReturnType<typeof harness>['store'], cwd: string, input = 'task') => {
  const session = newSession(store, cwd);
  return { session, run: enqueue(store, session.id, input) };
};

describe('blob ownership', () => {
  it('lets the run that put a blob read it, and another run of the same session', async () => {
    const { store } = harness();
    const { session, run } = runIn(store, '/work/a');
    const later = enqueue(store, session.id, 'later');
    const { handle } = await store.blobs.put('owned text', { mediaType: 'text/plain', runId: run.id });
    expect((await store.blobs.read(handle, LINES, { runId: run.id })).text).toBe('owned text');
    expect((await store.blobs.read(handle, LINES, { runId: later.id })).text).toBe('owned text');
    expect(mustRun(store, later.id).sessionId).toBe(session.id);
  });

  it('refuses a run of another session as if the blob did not exist', async () => {
    const { store } = harness();
    const owner = runIn(store, '/work/a');
    const stranger = runIn(store, '/work/b');
    const { handle } = await store.blobs.put('private text', { mediaType: 'text/plain', runId: owner.run.id });
    await expect(store.blobs.read(handle, LINES, { runId: stranger.run.id })).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
    const unknown = '0'.repeat(64);
    await expect(store.blobs.read(unknown, LINES, { runId: stranger.run.id })).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

  it('keeps one blob readable by every session that put the same content', async () => {
    const { store } = harness();
    const first = runIn(store, '/work/a');
    const second = runIn(store, '/work/b');
    const { handle } = await store.blobs.put('shared text', { mediaType: 'text/plain', runId: first.run.id });
    await store.blobs.put('shared text', { mediaType: 'text/plain', runId: second.run.id });
    expect((await store.blobs.read(handle, LINES, { runId: second.run.id })).text).toBe('shared text');
  });

  it('reads without a scope for the store itself', async () => {
    const { store } = harness();
    const { handle } = await store.blobs.put('internal', { mediaType: 'text/plain' });
    expect((await store.blobs.read(handle, LINES)).text).toBe('internal');
  });
});
