import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@momonga/testkit';
import type { FmServe, FmServeOptions } from '../src/managed/fm-serve.ts';
import { measureManagedFm } from '../src/probe/probe-fm.ts';

const FILE_GRACE_MS = 70;

const fakeServe = (events: string[]): ((options: FmServeOptions) => FmServe) => () =>
  ({
    restarts: 0,
    start: async () => {
      events.push('start');
      throw new Error('the probe server did not start');
    },
    ensureRunning: async () => {
      throw new Error('not used');
    },
    stop: async (stop?: { stopGraceMs: number }) => {
      events.push(`stop:${stop === undefined ? 'none' : stop.stopGraceMs}`);
    },
    health: async () => ({ ok: false, reason: 'not_running' }),
  }) as unknown as FmServe;

describe('the probe serve stop reads the stop grace at its begin (design 3.2)', () => {
  it('the stop in the finally of a probe uses the grace read when that stop begins, after the start', async (context) => {
    const events: string[] = [];
    const probe = measureManagedFm({
      binary: '/usr/bin/fm',
      socketPath: path.join(withTempDir(context), 'fm-probe.sock'),
      env: {},
      onWarning: () => undefined,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      createServe: fakeServe(events),
      spawn: () => {
        throw new Error('the probe server did not start');
      },
      readStopGraceMs: () => {
        events.push('read');
        return FILE_GRACE_MS;
      },
    });
    await expect(probe({ signal: new AbortController().signal } as never)).rejects.toThrow();
    expect(events).toEqual(['start', 'read', `stop:${FILE_GRACE_MS}`]);
  });
});
