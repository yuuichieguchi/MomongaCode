import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installTrust } from '../src/outbound.ts';
import type { NetworkConfig } from '../src/network-route.ts';

const noFiles = { readTextFile: (): Promise<string> => Promise.reject(new Error('no file is read in this test')) };
const noCaFiles: NetworkConfig = { caFiles: [] };
const fingerprints = (pems: readonly string[]): Set<string> => new Set(pems.map((pem) => new X509Certificate(pem).fingerprint256));
const neverSettles = (): Promise<readonly string[]> => new Promise<readonly string[]>(() => undefined);

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

const expectSystemFailure = (report: Awaited<ReturnType<typeof installTrust>>, abortReason: string): void => {
  expect(report.sources).toEqual([
    { source: 'bundled', certificates: bundled.length },
    { source: 'system', certificates: 0 },
    { source: 'NODE_EXTRA_CA_CERTS', certificates: extra.length },
  ]);
  expect(report.failures).toHaveLength(1);
  const [failure] = report.failures;
  expect(failure).toMatchObject({ source: 'system' });
  expect(failure).not.toHaveProperty('file');
  expect(failure?.reason.startsWith('the system store was not read:')).toBe(true);
  expect(failure?.reason).toContain(abortReason);
};

describe('installTrust ends the system store read when the signal of the operation that asked aborts', () => {
  it('resolves with a system failure when the signal is already aborted and the reader never settles', async () => {
    const report = await installTrust(noCaFiles, noFiles, {
      readSystemCertificates: neverSettles,
      signal: AbortSignal.abort(new Error('the start was stopped')),
    });

    expectSystemFailure(report, 'the start was stopped');
  });

  it('resolves with a system failure when the signal aborts while the reader is still reading', async () => {
    const controller = new AbortController();
    let readerCalled: () => void = () => undefined;
    const called = new Promise<void>((resolve) => {
      readerCalled = resolve;
    });

    const pending = installTrust(noCaFiles, noFiles, {
      readSystemCertificates: () => {
        readerCalled();
        return neverSettles();
      },
      signal: controller.signal,
    });
    await called;
    controller.abort(new Error('the host read bound passed'));
    const report = await pending;

    expectSystemFailure(report, 'the host read bound passed');
  });

  it('installs the bundled and extra certificates when the system read was abandoned', async () => {
    await installTrust(noCaFiles, noFiles, { readSystemCertificates: neverSettles, signal: AbortSignal.abort(new Error('stopped')) });

    expect(fingerprints(tls.getCACertificates('default'))).toEqual(fingerprints([...bundled, ...extra]));
  });
});
