import { describe, expect, it } from 'vitest';
import { PS_PROBE_TIMEOUT_MS } from '@momonga/foundation';
import { createProcessStartProbe } from '../src/process-lock.ts';
import type { ProbeExecFile } from '../src/process-lock.ts';

describe('ps probe timeout (A5)', () => {
  it('PS_PROBE_TIMEOUT_MS is 2000', () => {
    expect(PS_PROBE_TIMEOUT_MS).toBe(2000);
  });

  it('createProcessStartProbe passes the timeout and SIGKILL to execFile with LC_ALL and TZ set', async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: { env: Record<string, string>; timeout: number; killSignal: NodeJS.Signals } }> = [];
    const execFile: ProbeExecFile = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, 'Thu Jan  1 00:00:00 2026\n');
    };
    const probe = createProcessStartProbe({ execFile, timeoutMs: PS_PROBE_TIMEOUT_MS, platform: 'darwin' });
    const value = await probe(123);
    expect(value).toBeTypeOf('number');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('/bin/ps');
    expect(calls[0]?.args).toEqual(['-o', 'lstart=', '-p', '123']);
    expect(calls[0]?.options.timeout).toBe(PS_PROBE_TIMEOUT_MS);
    expect(calls[0]?.options.killSignal).toBe('SIGKILL');
    expect(calls[0]?.options.env).toEqual({ LC_ALL: 'C', TZ: 'UTC' });
  });

  it('a timed-out execFile yields undefined', async () => {
    const execFile: ProbeExecFile = (_file, _args, _options, callback) => {
      callback(new Error('timed out'), '');
    };
    const probe = createProcessStartProbe({ execFile, timeoutMs: PS_PROBE_TIMEOUT_MS, platform: 'darwin' });
    expect(await probe(123)).toBeUndefined();
  });
});
