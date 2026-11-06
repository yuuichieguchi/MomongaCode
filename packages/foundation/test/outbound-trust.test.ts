import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installTrust } from '@momonga/foundation';
import type { NetworkConfig } from '@momonga/foundation';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'test-ca.pem');

const fingerprints = (pems: readonly string[]): Set<string> => new Set(pems.map((pem) => new X509Certificate(pem).fingerprint256));

const readFile = (file: string): Promise<string> => fs.promises.readFile(file, 'utf8');

let original: string[] = [];
let scratch = '';

beforeAll(() => {
  original = tls.getCACertificates('default');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-trust-'));
});

afterAll(() => {
  tls.setDefaultCACertificates(original);
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('installTrust', () => {
  it('installs the union of the bundled set, the OS store, the extra set and every readable file, process-wide', async () => {
    const before = { bundled: tls.getCACertificates('bundled'), system: tls.getCACertificates('system'), extra: tls.getCACertificates('extra') };
    const config: NetworkConfig = { caFiles: [{ value: FIXTURE, source: 'network.extraCaFiles' }] };

    const report = await installTrust(config, readFile);

    const installed = fingerprints(tls.getCACertificates('default'));
    for (const fingerprint of fingerprints([...before.bundled, ...before.system, ...before.extra])) expect(installed.has(fingerprint)).toBe(true);
    expect(installed.has(new X509Certificate(fs.readFileSync(FIXTURE, 'utf8')).fingerprint256)).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.sources).toContainEqual({ source: 'network.extraCaFiles', file: FIXTURE, certificates: 1 });
    expect(report.sources.map((entry) => entry.source)).toEqual(expect.arrayContaining(['bundled', 'system']));
  });

  it('reports a file that cannot be read with the variable that selected it, and still installs the rest', async () => {
    const missing = path.join(scratch, 'missing.pem');
    const config: NetworkConfig = {
      caFiles: [
        { value: FIXTURE, source: 'network.extraCaFiles' },
        { value: missing, source: 'SSL_CERT_FILE' },
      ],
    };

    const report = await installTrust(config, readFile);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ file: missing, source: 'SSL_CERT_FILE' });
    expect(fingerprints(tls.getCACertificates('default')).has(new X509Certificate(fs.readFileSync(FIXTURE, 'utf8')).fingerprint256)).toBe(true);
  });

  it('reports a file that holds no certificate', async () => {
    const empty = path.join(scratch, 'not-a-cert.pem');
    fs.writeFileSync(empty, 'this is not a certificate\n');

    const report = await installTrust({ caFiles: [{ value: empty, source: 'network.extraCaFiles' }] }, readFile);

    expect(report.failures).toEqual([{ file: empty, source: 'network.extraCaFiles', reason: 'the file holds no certificate' }]);
  });
});
