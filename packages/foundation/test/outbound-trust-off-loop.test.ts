import tls from 'node:tls';
import { isMainThread } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installTrust } from '../src/outbound.ts';
import type { NetworkConfig } from '../src/network-route.ts';

const systemReadsOnMainThread = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>();
  const getCACertificates = (type?: Parameters<typeof actual.getCACertificates>[0]): string[] => {
    if (type === 'system' && isMainThread) {
      systemReadsOnMainThread.count += 1;
      const until = Date.now() + 200;
      while (Date.now() < until) {
        Math.sqrt(Math.random());
      }
    }
    return actual.getCACertificates(type);
  };
  const patched = { ...actual, getCACertificates };
  return { ...patched, default: patched };
});

const noFiles = { readTextFile: (): Promise<string> => Promise.reject(new Error('no file is read in this test')) };
const noCaFiles: NetworkConfig = { caFiles: [] };

let original: string[] = [];

beforeAll(() => {
  original = tls.getCACertificates('default');
});

afterAll(() => {
  tls.setDefaultCACertificates(original);
});

describe('installTrust reads the system CA store off the main event loop', () => {
  it('never reads the system store on the main thread', async () => {
    systemReadsOnMainThread.count = 0;

    const report = await installTrust(noCaFiles, noFiles);

    expect(systemReadsOnMainThread.count).toBe(0);
    expect(report.sources.map((entry) => entry.source)).toEqual(['bundled', 'system', 'NODE_EXTRA_CA_CERTS']);
  });
});
