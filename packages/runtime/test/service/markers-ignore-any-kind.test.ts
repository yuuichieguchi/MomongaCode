import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { momongaLayout, momongaPaths } from '@momonga/foundation';
import { startService } from './helpers.ts';

const MANAGED_MARKER = '6f1c2a9e-0b7d-4a51-9c3e-2d8f5b7a1e04';

type InstancePaths = (paths: ReturnType<typeof momongaPaths>, instance: { owner: 'gateway' | 'cli'; purpose: 'serve' | 'probe'; target: string }) => { markerDirectory: string };

const managedInstancePaths: InstancePaths = (paths, instance) => {
  const value = (foundation as Record<string, unknown>)['managedInstancePaths'];
  if (value === undefined) throw new Error('@momonga/foundation does not export managedInstancePaths');
  return (value as InstancePaths)(paths, instance);
};

describe('/markers ignore accepts every marker kind (design-managed-servers section 17, item 17; decision 12)', () => {
  it('sets the ignored byte of a managed server marker under markers/targets/<target>, named as the survivor notice names it', async () => {
    const env = await startService({ fakeTimers: true });
    const dir = path.join(momongaLayout(env.layout.home, process.platform, process.env).markers.targets, 'apple');
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, MANAGED_MARKER);
    fs.writeFileSync(marker, 'r00110\n');
    const answered = await env.http('POST', `/v1/markers/${MANAGED_MARKER}/ignore`);
    expect(answered.status).toBe(204);
    expect(fs.readFileSync(marker, 'utf8')).toBe('r00111\n');
  });

  it('sets the ignored byte of a CLI probe marker, which lives outside markers/targets', async () => {
    const env = await startService({ fakeTimers: true });
    const dir = managedInstancePaths(momongaPaths(env.layout.home, process.platform, {}), { owner: 'cli', purpose: 'probe', target: 'apple' }).markerDirectory;
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, MANAGED_MARKER);
    fs.writeFileSync(marker, 'r00010\n');
    const answered = await env.http('POST', `/v1/markers/${MANAGED_MARKER}/ignore`);
    expect(answered.status).toBe(204);
    expect(fs.readFileSync(marker, 'utf8')).toBe('r00011\n');
  });
});
