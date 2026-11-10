import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec } from '@momonga/testkit';
import { makeDir, postJson, readJson, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, homePaths, launchGateway, makeHome, writeSettings, modelsOf } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';
import { saveFakeFmRecord } from '../fm-record-support.ts';
import { makeReport } from '../report-fixture.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const NOT_LISTED_YET = 'not listed yet';

const traceBytesUnder = (root: string): string => {
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  return files
    .filter((file) => file.includes(`${path.sep}traces${path.sep}`))
    .map((file) => fs.readFileSync(file).toString('latin1'))
    .join('\n');
};

const servedOnce = async (target: Record<string, unknown>, recorded: boolean): Promise<string> => {
  const fm = await createFakeFm({ dir: makeDir() });
  const home = makeHome();
  writeSettings(home, { models: modelsOf({ apple: { adapter: 'managed', server: 'fm', model: 'system', binary: fm.binaryPath, toolCalling: 'native', ...target } }) });
  if (recorded) await saveFakeFmRecord(home, fm.binaryPath, makeReport(1, 1), typeof target['model'] === 'string' ? target['model'] : undefined);
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec } as GatewayProcessOptions);
  const answered = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'apple/system', input: userInput('hello') }));
  expect(answered.status).toBe(200);
  await handle.close();
  return traceBytesUnder(homePaths(home).root);
};

describe('rule M: the shown model of a managed target (design-managed-servers section 7 row 10; section 18, item 5)', () => {
  it('is the id the server lists after its first probe when no model is declared, never "not listed yet" and never the target name', async () => {
    const traces = await servedOnce({}, true);
    expect(traces).toContain('system');
    expect(traces).not.toContain(NOT_LISTED_YET);
  });

  it('is the declared model when one is declared', async () => {
    const traces = await servedOnce({ model: 'system' }, true);
    expect(traces).toContain('system');
    expect(traces).not.toContain(NOT_LISTED_YET);
  });
});
