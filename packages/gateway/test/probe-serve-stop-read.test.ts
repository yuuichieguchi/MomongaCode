import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FM_SERVER } from '@momonga/protocol';
import { withTempDir, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { measureManagedServer } from '../src/probe/probe-fm.ts';
import { systemTiming } from '@momonga/foundation';

const FILE_GRACE_MS = 70;

describe('the probe server stop reads the stop grace at its begin (design 3.2)', () => {
  it('the stop in the finally of a probe uses the grace read when that stop begins, after the start', async (context) => {
    const dir = withTempDir(context);
    const markerDirectory = path.join(dir, 'markers');
    fs.mkdirSync(markerDirectory, { mode: 0o700 });
    const events: string[] = [];
    const probe = measureManagedServer({
      timers: systemTiming,
      inspector: testProcessInspector(),
      lock: testKernelLock(),
      description: FM_SERVER,
      target: 'apple',
      binary: '/usr/bin/fm',
      instance: { socketPath: path.join(dir, 'p.sock'), lockPath: path.join(dir, 'p.lock'), markerDirectory },
      readyTimeoutMs: FM_SERVER.ready.limitMs,
      env: {},
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      execWithStdin: async () => ({ exitCode: 0, stdout: '1\n', stderr: '' }),
      model: 'apple-fm',
      onWarning: () => undefined,
      spawn: () => {
        events.push('spawn');
        throw new Error('the probe server did not start');
      },
      readStopGraceMs: () => {
        events.push('read');
        return FILE_GRACE_MS;
      },
    });
    await expect(probe({ key: {}, signal: new AbortController().signal })).rejects.toThrow();
    expect(events.slice(events.indexOf('spawn'))).toEqual(['spawn', 'read']);
  });
});
