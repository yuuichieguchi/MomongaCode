import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installTrust } from '../src/outbound.ts';
import type { NetworkConfig } from '../src/network-route.ts';

const noFiles = { readTextFile: (): Promise<string> => Promise.reject(new Error('no file is read in this test')) };
const noCaFiles: NetworkConfig = { caFiles: [] };

let original: string[] = [];
let bundled: string[] = [];
let extra: string[] = [];

beforeAll(() => {
  original = tls.getCACertificates('default');
  bundled = tls.getCACertificates('bundled');
  extra = tls.getCACertificates('extra');
});

afterAll(() => {
  tls.setDefaultCACertificates(original);
});

describe('installTrust takes the system store from its one reader', () => {
  it('reports the certificates the system reader returned and installs them', async () => {
    const twoFromSystem = bundled.slice(0, 2);

    const report = await installTrust(noCaFiles, noFiles, { readSystemCertificates: () => Promise.resolve(twoFromSystem) });

    expect(report).toEqual({
      sources: [
        { source: 'bundled', certificates: bundled.length },
        { source: 'system', certificates: 2 },
        { source: 'NODE_EXTRA_CA_CERTS', certificates: extra.length },
      ],
      failures: [],
    });
  });

  it('reports the system source with no certificates and the reason when the reader fails, and still installs the rest', async () => {
    const report = await installTrust(noCaFiles, noFiles, {
      readSystemCertificates: () => Promise.reject(new Error('this platform has no system store reader')),
    });

    expect(report.sources).toEqual([
      { source: 'bundled', certificates: bundled.length },
      { source: 'system', certificates: 0 },
      { source: 'NODE_EXTRA_CA_CERTS', certificates: extra.length },
    ]);
    expect(report.failures).toHaveLength(1);
    expect(JSON.stringify(report.failures[0])).toContain('this platform has no system store reader');
    expect(JSON.stringify(report.failures[0])).toContain('system');
    expect(tls.getCACertificates('default').length).toBe(bundled.length + extra.length);
  });
});
