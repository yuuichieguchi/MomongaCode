import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { writeUserSettings } from './helpers.ts';
import { RUNTIME_VERSION, captureStream, hookLogger, makeRunHome, startRuntimeProcess } from './run-helpers.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FIXTURE = path.resolve(import.meta.dirname, '..', '..', '..', 'foundation', 'test', 'fixtures', 'test-ca.pem');

const installed = (pem: string): boolean => {
  const wanted = new X509Certificate(pem).fingerprint256;
  return tls.getCACertificates('default').some((entry) => new X509Certificate(entry).fingerprint256 === wanted);
};

describe('runtime process start', () => {
  it('installs the trust of the network settings before it serves', async () => {
    const temp = makeRunHome();
    fs.mkdirSync(temp.paths.root, { recursive: true, mode: 0o700 });
    writeUserSettings(temp.home, { sandbox: 'none', network: { extraCaFiles: [FIXTURE] } });
    const pem = fs.readFileSync(FIXTURE, 'utf8');
    expect(installed(pem)).toBe(false);

    const runtimeProcess = await startRuntimeProcess({ generation: FIRST_GENERATION, home: temp.home, version: RUNTIME_VERSION, logger: hookLogger(() => undefined), stdout: captureStream() });
    try {
      expect(installed(pem)).toBe(true);
    } finally {
      await runtimeProcess.close();
    }
  });
});
