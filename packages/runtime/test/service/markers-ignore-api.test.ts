import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { startService } from './helpers.ts';

const NAME = 'a'.repeat(64);

describe('T17 (d) POST /v1/markers/:name/ignore (decision 45 A)', () => {
  it('sets the ignored byte of an unsettled marker in place', async () => {
    const env = await startService({ fakeTimers: true });
    const dir = momongaLayout(env.layout.home).markers.tools;
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, NAME);
    fs.writeFileSync(marker, 'r10000\n');
    const answered = await env.http('POST', `/v1/markers/${NAME}/ignore`);
    expect(answered.status).toBeLessThan(300);
    expect(fs.readFileSync(marker, 'utf8')).toBe('r10001\n');
  });

  it('answers a name that is not an unsettled marker with "no unsettled marker has that name" and changes nothing', async () => {
    const env = await startService({ fakeTimers: true });
    const answered = await env.http('POST', `/v1/markers/${'b'.repeat(64)}/ignore`);
    expect(answered.status).toBeGreaterThanOrEqual(400);
    expect(answered.text).toContain('no unsettled marker has that name');
  });
});
