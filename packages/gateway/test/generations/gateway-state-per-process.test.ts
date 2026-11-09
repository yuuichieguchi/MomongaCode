import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveProbeRecord } from '@momonga/gateway';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeFm, fakeExec } from '@momonga/testkit';
import { getJson, makeDir } from '../gateway-helpers.ts';
import { makeReport } from '../report-fixture.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';
import { CURRENT_DIALECTS } from '../dialect-currency.ts';

const generationOptions = (options: GatewayProcessOptions, generation: number): GatewayProcessOptions => ({ ...options, generation } as GatewayProcessOptions);

const capabilitySource = async (socketPath: string): Promise<string> => {
  const models = await getJson(clientFor(socketPath), '/v1/momonga/models');
  const entry = models.body.data.find((model: { id: string }) => model.id === 'default');
  return entry.capabilities.source;
};

describe('H6: gateway state belongs to its process; a new generation is how a probe takes effect', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('serves the probe record written after generation 1 started only from generation 2, while generation 1 keeps the record it loaded', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const home = makeHome();
    writeSettings(home, { models: { aliases: { default: ['fm'] }, targets: { fm: { adapter: 'fm' } } } });
    const options: GatewayProcessOptions = { home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec };

    const first = await launchGateway(generationOptions(options, 1));
    expect(await capabilitySource(first.socketPath)).toBe('unprobed');

    const binarySha256 = createHash('sha256').update(fs.readFileSync(fm.binaryPath)).digest('hex');
    await saveProbeRecord(path.join(home, '.momonga', 'state', 'probe'), { target: 'fm', binarySha256, osBuild: FAKE_OS_BUILD }, makeReport(1, 1), CURRENT_DIALECTS);

    const second = await launchGateway(generationOptions(options, 2));
    expect(second.socketPath).not.toBe(first.socketPath);
    expect(await capabilitySource(second.socketPath)).toBe('probed');
    expect(await capabilitySource(first.socketPath)).toBe('unprobed');
  });
});
