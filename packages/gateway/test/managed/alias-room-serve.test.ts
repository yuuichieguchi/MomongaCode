import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec } from '@momonga/testkit';
import type { ProbeReport } from '@momonga/protocol';
import { makeDir, postJson, readJson, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';
import { saveFakeFmRecord } from '../fm-record-support.ts';
import { makeReport } from '../report-fixture.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const unboundedReport: ProbeReport = { ...makeReport(1, 1), outputBoundField: 'none' } as ProbeReport;

const rAliasText = (alias: string, unbounded: string, other: string): string =>
  `models.aliases.${alias}: target "${unbounded}" has no output bound, and the target "${other}" neither declares nor reports a contextWindow or maxOutputTokens, so the input room of the alias cannot be checked; declare them or remove one of the targets`;

const setup = async (appleReport: ProbeReport) => {
  const appleFm = await createFakeFm({ dir: makeDir() });
  const bananaFm = await createFakeFm({ dir: makeDir() });
  fs.appendFileSync(bananaFm.binaryPath, '\n');
  expect(fs.readFileSync(appleFm.binaryPath)).not.toEqual(fs.readFileSync(bananaFm.binaryPath));
  const home = makeHome();
  writeSettings(home, {
    models: {
      targets: {
        apple: { adapter: 'managed', server: 'fm', binary: appleFm.binaryPath, toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } },
        banana: { adapter: 'managed', server: 'fm', binary: bananaFm.binaryPath, toolCalling: 'native' },
      },
      aliases: { default: ['apple', 'banana'] },
    },
  });
  await saveFakeFmRecord(home, appleFm.binaryPath, appleReport);
  await saveFakeFmRecord(home, bananaFm.binaryPath, makeReport(1, 1));
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec } as GatewayProcessOptions);
  return clientFor(handle.socketPath);
};

describe('R-ALIAS is checked when a request is served, with the declared or measured values (design-managed-servers section 18, item 3)', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('refuses the alias with the R-ALIAS text when a member measured as unbounded sits beside a member whose maxOutputTokens is neither declared nor reported after its probe', async () => {
    const client = await setup(unboundedReport);
    const answered = await readJson(await postJson(client, '/v1/responses', { model: 'default', input: userInput('hello') }));
    expect(answered.status).not.toBe(200);
    expect(JSON.stringify(answered.body)).toContain(JSON.stringify(rAliasText('default', 'apple', 'banana')).slice(1, -1));
  });

  it('serves the same alias when every member is measured as output-bounded', async () => {
    const client = await setup(makeReport(1, 1));
    const answered = await readJson(await postJson(client, '/v1/responses', { model: 'default', input: userInput('hello') }));
    expect(answered.status).toBe(200);
  });
});
