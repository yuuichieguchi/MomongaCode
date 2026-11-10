import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboundNetwork } from '@momonga/foundation';
import type { CliPorts } from '../src/ports.ts';

const reader = vi.hoisted(() => ({
  read: (): Promise<readonly string[]> => new Promise<readonly string[]>(() => undefined),
  signals: [] as Array<AbortSignal | undefined>,
}));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  const installTrust: typeof actual.installTrust = (config, files, options = {}) => {
    reader.signals.push(options.signal);
    return actual.installTrust(config, files, { ...options, readSystemCertificates: () => reader.read() });
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

const freshNetwork = async (): Promise<typeof import('../src/network.ts')> => {
  vi.resetModules();
  reader.signals.length = 0;
  return import('../src/network.ts');
};

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('the CLI reads the trust store under the one CLI host-read bound', () => {
  it('foundation exports HOST_READ_BOUND_MS as 300 000 ms', async () => {
    const foundation = (await import('@momonga/foundation')) as Record<string, unknown>;

    expect(foundation['HOST_READ_BOUND_MS']).toBe(300_000);
  });

  it('a read that never settles is live at the bound minus 1 ms and ends with a system failure at the bound', async () => {
    const { HOST_READ_BOUND_MS } = await import('@momonga/foundation');
    reader.read = () => new Promise<readonly string[]>(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { withOutboundNetwork } = await freshNetwork();
    let settled: OutboundNetwork | undefined;

    void withOutboundNetwork(ports(), new AbortController().signal, async (network) => {
      settled = network;
    });
    while (reader.signals.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const signal = reader.signals[0];
    vi.advanceTimersByTime(HOST_READ_BOUND_MS - 1);
    await flush();

    expect(signal?.aborted).toBe(false);
    expect(settled).toBeUndefined();

    vi.advanceTimersByTime(1);
    while (settled === undefined) await new Promise<void>((resolve) => setImmediate(resolve));

    expect(signal?.aborted).toBe(true);
    expect(settled.trust.sources.find((entry) => entry.source === 'system')).toEqual({ source: 'system', certificates: 0 });
    expect(settled.trust.failures).toHaveLength(1);
    expect(settled.trust.failures[0]?.reason.startsWith('the system store was not read:')).toBe(true);
  });

  it('clears the bound when the read settles, so no timer is left and the signal never aborts', async () => {
    const { HOST_READ_BOUND_MS } = await import('@momonga/foundation');
    reader.read = () => Promise.resolve([]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { withOutboundNetwork } = await freshNetwork();

    const network = await withOutboundNetwork(ports(), new AbortController().signal, async (admitted) => admitted);

    expect(network.trust.failures).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HOST_READ_BOUND_MS);
    expect(reader.signals[0]?.aborted).toBe(false);
  });
});
