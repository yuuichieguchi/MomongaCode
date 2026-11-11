import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { generationLayout, syncPaths } from '@momonga/foundation';
import * as protocol from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, firstGeneration } from '@momonga/testkit';
import { httpOver, startHarness } from './fixtures/p3-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('the health of the supervisor carries no version of its API, which no reader compares', () => {
  it('has no apiVersion, in the value and on the control socket', async (context) => {
    const h = await startHarness(context);
    expect(Object.keys(h.health())).not.toContain('apiVersion');
    const answered = await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health');
    expect(Object.keys(JSON.parse(answered.text) as object)).not.toContain('apiVersion');
    expect(Object.keys(protocol)).not.toContain('SUPERVISOR_API_VERSION');
  });

  it('an abandoned start answers a health without apiVersion', async (context) => {
    const h = await startHarness(context, { generation: 2, prepare: (home) => fs.rmSync(generationLayout(syncPaths.canonicalPath(home), 2).dir, { recursive: true }) });
    expect(h.supervisor.abandoned).toBe('directory-missing');
    expect(Object.keys(h.health())).not.toContain('apiVersion');
  });
});
