import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProbeRecord, probeManagedFm } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec } from '@momonga/testkit';
import { makeHome } from './gateway-process-helpers.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';

const setup = async (): Promise<{ dir: string; binary: string; probeDir: string; socketPath: string }> => {
  const dir = makeHome();
  const fm = await createFakeFm({ dir });
  const probeDir = path.join(dir, 'probe');
  return { dir, binary: fm.binaryPath, probeDir, socketPath: path.join(dir, 'fm-probe.sock') };
};

const options = (paths: Awaited<ReturnType<typeof setup>>, warnings: string[] = []) => ({
  paths: { probe: paths.probeDir },
  target: 'fm',
  binary: paths.binary,
  socketPath: paths.socketPath,
  env: { PATH: '/usr/bin:/bin', HOME: paths.dir },
  samples: 2,
  exec: fakeExec,
  onWarning: (message: string) => void warnings.push(message),
});

describe('probeManagedFm', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('serves fm on its own socket, probes it and records the report under the binary and the OS build', async () => {
    const paths = await setup();

    const result = await probeManagedFm(options(paths));

    expect(result.record.target).toBe('fm');
    expect(result.record.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.report.health).toEqual({ ok: true });
    expect(['native', 'constrained', 'none']).toContain(result.toolCalling);
    expect(await loadProbeRecord(paths.probeDir, result.record, CURRENT_DIALECTS)).toEqual(result.report);
    expect(fs.existsSync(paths.socketPath)).toBe(false);
  });

  it('records nothing and reports the remedy when fm is not licensed', async () => {
    const paths = await setup();
    const unlicensed = path.join(paths.dir, 'unlicensed-fm');
    fs.writeFileSync(unlicensed, '#!/bin/sh\nexit 69\n', { mode: 0o755 });

    const failure = await probeManagedFm({ ...options(paths), binary: unlicensed }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: 'PreconditionFailedError', remediation: 'sudo fm license' });
    expect(fs.existsSync(paths.probeDir)).toBe(false);
  });
});
