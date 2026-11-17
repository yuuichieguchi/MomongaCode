import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { FM_HOST, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm } from '@momonga/testkit';
import type { ProbeReport } from '@momonga/protocol';
import { makeDir, postJson, readJson, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from '../gateway-process-helpers.ts';
import { saveFakeFmRecord } from '../fm-record-support.ts';
import { makeReport } from '../report-fixture.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const unboundedReport: ProbeReport = { ...makeReport(1, 1), outputBoundField: 'none' } as ProbeReport;
const boundedReport: ProbeReport = { ...makeReport(1, 1), outputBoundField: 'max_tokens' };

const unknownRoomText = (first: string, unbounded: string, other: string): string =>
  `${first}: ${unbounded} has no output bound, and ${other} neither declares nor reports a contextWindow or maxOutputTokens, so the input room of ${first} and the models it falls back to cannot be known`;

const setup = async (appleReport: ProbeReport, bananaReport: ProbeReport) => {
  const appleFm = await createFakeFm({ dir: makeDir() });
  const bananaFm = await createFakeFm({ dir: makeDir() });
  fs.appendFileSync(bananaFm.binaryPath, '\n');
  expect(fs.readFileSync(appleFm.binaryPath)).not.toEqual(fs.readFileSync(bananaFm.binaryPath));
  const home = makeHome();
  writeSettings(home, {
    models: modelsOf({
        apple: { adapter: 'managed', server: 'fm', model: 'system', binary: appleFm.binaryPath, toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } },
        banana: { adapter: 'managed', server: 'fm', model: 'system', binary: bananaFm.binaryPath, toolCalling: 'native' },
      }, { fallbackTo: ['banana'] }),
  });
  await saveFakeFmRecord(home, appleFm.binaryPath, appleReport);
  await saveFakeFmRecord(home, bananaFm.binaryPath, bananaReport);
  const handle = await launchGateway({ ...FM_HOST, generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
  return clientFor(handle.socketPath);
};

describe('R-ALIAS is checked when a request is served, with the declared or measured values (design-managed-servers section 18, item 3)', () => {
  it('refuses the model with the room text when a member measured as unbounded sits beside a member whose maxOutputTokens is neither declared nor reported after its probe', async () => {
    const client = await setup(unboundedReport, boundedReport);
    const answered = await readJson(await postJson(client, '/v1/responses', { model: 'apple/system', input: userInput('hello') }));
    expect(answered.status).toBe(412);
    expect(answered.body.error).toMatchObject({ code: 'chain_room_refused', param: 'model', message: unknownRoomText('apple/system', 'apple/system', 'banana/system') });
  });

  it('serves the same model when every member is measured as output-bounded', async () => {
    const client = await setup(boundedReport, boundedReport);
    const answered = await readJson(await postJson(client, '/v1/responses', { model: 'apple/system', input: userInput('hello') }));
    expect(answered.status).toBe(200);
  });
});
