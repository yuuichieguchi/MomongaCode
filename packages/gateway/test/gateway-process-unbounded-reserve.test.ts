import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { saveEndpointRecord } from '@momonga/gateway';
import type { ProbeReport } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { startFake } from './cc-support.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { getJson } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, homePaths, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { makeReport } from './report-fixture.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const honoursNoBound: ProbeReport = { ...makeReport(1, 1), outputBoundField: 'none' };

describe('the gateway reads context.unboundedOutputReserve from user settings per operation (O-R5-3 a, P2 item 7)', () => {
  it('lists outputBoundField none for a probed-none record only while the user setting is on, with no restart', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    const models = { aliases: { fast: ['primary'] }, targets: { primary: ccTarget(fake.socketPath, { toolCalling: 'auto' }) } };
    writeSettings(home, { models });
    await saveEndpointRecord(path.join(homePaths(home).root, 'state', 'probe'), { endpoint: `unix:${fake.socketPath}`, model: 'system' }, 'identity-one', ['id', 'object', 'owned_by'], honoursNoBound as never, CURRENT_DIALECTS);
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    const listed = async () => {
      const response = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
      expect(response.status).toBe(200);
      return response.body.data.find((entry: { id: string }) => entry.id === 'fast').capabilities;
    };

    expect((await listed()).outputBoundField).not.toBe('none');

    writeSettings(home, { models, context: { unboundedOutputReserve: true } });
    expect((await listed()).outputBoundField).toBe('none');

    writeSettings(home, { models, context: { unboundedOutputReserve: false } });
    expect((await listed()).outputBoundField).not.toBe('none');
    await handle.close();
  });
});
