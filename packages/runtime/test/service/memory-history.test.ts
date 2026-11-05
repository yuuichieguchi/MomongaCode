import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startService } from './helpers.ts';

describe('GET /v1/memories/:id/history shows validity', () => {
  it('history lists each note with its intervals', async () => {
    const env = await startService({ fakeTimers: true });
    expect((await env.http('PUT', '/v1/trust', { body: { path: env.layout.projectReal, decision: 'trusted' } })).status).toBe(200);
    const project = env.layout.projectReal;
    fs.writeFileSync(path.join(project, 'config.ts'), 'export const LIMIT = 10;\n');
    const added = await env.http('POST', '/v1/memories', { body: { text: 'LIMIT is 10.', scope: 'project', project, paths: ['config.ts'] } });
    expect(added.status).toBe(201);
    const savedAt = env.clock.now();
    env.clock.advance(60_000);
    fs.writeFileSync(path.join(project, 'config.ts'), 'export const LIMIT = 20;\n');
    const foundAt = env.clock.now();
    const history = await env.http('GET', `/v1/memories/${added.json.memory.id}/history`);
    expect(history.status).toBe(200);
    expect(history.json.memories).toHaveLength(1);
    expect(history.json.memories[0].status).toBe('stale');
    expect(history.json.memories[0].validity).toEqual({
      intervals: [
        { status: 'verified', from: savedAt, to: foundAt, closedBy: 'observation' },
        { status: 'stale', from: foundAt, to: null, closedBy: null },
      ],
      changes: [{ from: 'verified', to: 'stale', changedBetween: [savedAt, foundAt] }],
    });
  });
});
