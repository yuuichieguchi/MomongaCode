import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliPorts } from '../src/ports.ts';

const captured = vi.hoisted(() => ({ signals: [] as Array<AbortSignal | undefined> }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  const installTrust = (...args: Parameters<typeof actual.installTrust>): ReturnType<typeof actual.installTrust> => {
    const options = args[2] as { signal?: AbortSignal } | undefined;
    captured.signals.push(options?.signal);
    return Promise.resolve({ sources: [], failures: [] });
  };
  return { ...actual, installTrust };
});

const homes: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const ports = (): CliPorts => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-cli-trust-'));
  homes.push(home);
  return {
    home,
    env: {},
    files: { readTextFile: () => Promise.reject(new Error('no file is read in this test')) },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  } as unknown as CliPorts;
};

describe('the CLI reads the trust store under the one CLI host-read bound', () => {
  it('foundation exports HOST_READ_BOUND_MS as 300 000 ms', async () => {
    const foundation = (await import('@momonga/foundation')) as Record<string, unknown>;

    expect(foundation['HOST_READ_BOUND_MS']).toBe(300_000);
  });

  it('passes installTrust a signal that aborts exactly when HOST_READ_BOUND_MS has passed', async () => {
    const foundation = (await import('@momonga/foundation')) as Record<string, unknown>;
    const bound = foundation['HOST_READ_BOUND_MS'] as number;
    expect(bound).toBe(300_000);
    vi.resetModules();
    captured.signals.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { processOutboundNetwork } = await import('../src/network.ts');

    await processOutboundNetwork(ports());

    expect(captured.signals).toHaveLength(1);
    const signal = captured.signals[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    vi.advanceTimersByTime(bound - 1);
    expect(signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal?.aborted).toBe(true);
  });
});
