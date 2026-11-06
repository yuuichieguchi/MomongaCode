import { describe, expect, it } from 'vitest';
import { MEMORY_PAGE_ROWS } from '../../src/process/constants.ts';
import { startService } from './helpers.ts';

describe('GET /v1/memories is paged', () => {
  it('GET /v1/memories answers one page with a cursor', async () => {
    const env = await startService({ fakeTimers: true });
    const total = MEMORY_PAGE_ROWS + 3;
    const ids = Array.from({ length: total }, (_unused, index) => env.store.memories.addByCommand({ scope: 'user', project: null, text: `note ${index}`, evidence: [] }).id);
    const first = await env.http('GET', '/v1/memories');
    expect(first.status).toBe(200);
    expect(first.json.memories).toHaveLength(MEMORY_PAGE_ROWS);
    expect(typeof first.json.next).toBe('string');
    const second = await env.http('GET', `/v1/memories?after=${encodeURIComponent(first.json.next)}`);
    expect(second.status).toBe(200);
    expect(second.json.memories).toHaveLength(3);
    expect(second.json.next).toBeNull();
    const seen = [...first.json.memories, ...second.json.memories].map((memory: { id: string }) => memory.id);
    expect(new Set(seen).size).toBe(total);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('refuses a cursor it did not issue', async () => {
    const env = await startService({ fakeTimers: true });
    const answer = await env.http('GET', '/v1/memories?after=not-a-cursor');
    expect(answer.status).toBe(400);
    expect(answer.json.error.param).toBe('after');
  });
});
