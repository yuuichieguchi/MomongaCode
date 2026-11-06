import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { ProbeReport } from '@momonga/protocol';
import { ProbeInProgressError, acquireProbeLock, probeManagedFm } from '@momonga/gateway';
import type { ProbeRecordKey } from '@momonga/gateway';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeFm, fakeExec } from '@momonga/testkit';
import { getJson, makeDir, postJson, readJson, userInput } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, until, writeSettings } from './gateway-process-helpers.ts';
import { readFileTool } from './cc-support.ts';

type Measure = { key: ProbeRecordKey; signal: AbortSignal; resolve: (report: ProbeReport) => void; reject: (error: Error) => void };

const sha256Of = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const setup = async (toolCalling?: 'native') => {
  const fm = await createFakeFm({ dir: makeDir() });
  const home = makeHome();
  writeSettings(home, {
    models: {
      aliases: { default: ['fm'], other: ['spare'] },
      targets: { fm: { adapter: 'fm', ...(toolCalling === undefined ? {} : { toolCalling }) }, spare: { adapter: 'fm', toolCalling: 'native' } },
    },
  });
  const os = { build: FAKE_OS_BUILD };
  const exec = async (file: string, args: readonly string[]) =>
    path.basename(file) === 'sw_vers' ? { exitCode: 0, stdout: `${os.build}\n`, stderr: '' } : fakeExec(file, args);
  const measures: Measure[] = [];
  const handle = await launchGateway({
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    fmBinary: fm.binaryPath,
    exec,
    measureFm: ({ key, signal }: { key: ProbeRecordKey; signal: AbortSignal }) =>
      new Promise<ProbeReport>((resolve, reject) => {
        measures.push({ key, signal, resolve, reject });
      }),
  });
  const client = clientFor(handle.socketPath);
  const probeDir = path.join(home, '.momonga', 'state', 'probe');
  const keyNow = (target = 'fm'): ProbeRecordKey => ({ target, binarySha256: sha256Of(fm.binaryPath), osBuild: os.build });
  const send = async (withTools = false) =>
    readJson(await postJson(client, '/v1/responses', { model: 'default', input: userInput('hello fm'), ...(withTools ? { tools: [readFileTool] } : {}) }));
  const sendRaw = (withTools = false) => postJson(client, '/v1/responses', { model: 'default', input: userInput('hello fm'), ...(withTools ? { tools: [readFileTool] } : {}) });
  const recordFile = path.join(probeDir, 'fm.json');
  const recordExists = (): boolean => fs.existsSync(recordFile);
  return { fm, home, os, measures, client, probeDir, keyNow, send, sendRaw, recordFile, recordExists };
};

const expectProbing = (response: { status: number; body: { error: { code: string; message: string } } }): void => {
  expect(response.status).toBe(503);
  expect(response.body.error.code).toBe(TARGET_PROBING);
  expect(response.body.error.message).toContain(TARGET_PROBING_MESSAGE);
};

describe('the automatic probe of an fm target with no probe record', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  describe('P3 NoRecordGets503 and RetryAfterIsHonest', () => {
    it('answers a request with tools 503 target_probing with Retry-After, never 412, and starts the probe for the current key', async () => {
      const gateway = await setup();

      const raw = await gateway.sendRaw(true);
      const response = await readJson(raw);

      expectProbing(response);
      expect(raw.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(gateway.measures.map((measure) => measure.key)).toEqual([gateway.keyNow()]);
    });
  });

  describe('P2 NoGuessedAnswer', () => {
    it('answers a request without tools 503 target_probing instead of serving it from a guessed context window', async () => {
      const gateway = await setup();

      expectProbing(await gateway.send(false));
      expect(gateway.measures).toHaveLength(1);
    });

    it('starts the probe for a target that declares its tool calling, because its context window is still unmeasured', async () => {
      const gateway = await setup('native');

      expectProbing(await gateway.send(false));
      expect(gateway.measures).toHaveLength(1);
    });

    it('keeps no guessed context window or output bound in the fm target', () => {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'managed', 'fm-target.ts'), 'utf8');

      expect(source).not.toMatch(/UNPROBED_CONTEXT_WINDOW|UNPROBED_MAX_OUTPUT_TOKENS|\b4096\b|\b1024\b/);
    });

    it('lists a probing alias with its probing state and no capability numbers, and still lists the other aliases', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));

      const listing = await getJson(gateway.client, '/v1/momonga/models');

      expect(listing.status).toBe(200);
      const entries = (listing.body as { data: Array<Record<string, unknown>> }).data;
      const probing = entries.find((entry) => entry['id'] === 'default');
      expect(probing).toMatchObject({ id: 'default', targets: ['fm'], probing: { message: expect.stringContaining(TARGET_PROBING_MESSAGE) } });
      expect((probing?.['probing'] as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
      expect(probing).not.toHaveProperty('capabilities');
      expect(probing).not.toHaveProperty('targetCapabilities');
      expect(entries.map((entry) => entry['id']).sort()).toEqual(['default', 'other']);
    });
  });

  describe('P1 SingleProbePerKey', () => {
    it('starts one probe for concurrent requests on the same key', async () => {
      const gateway = await setup();

      const responses = await Promise.all([gateway.send(true), gateway.send(true), gateway.send(false)]);

      for (const response of responses) expectProbing(response);
      expect(gateway.measures).toHaveLength(1);
    });

    it('refuses the momonga gateway probe command while the gateway measures the same key, without starting fm', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(true));

      const failure = await probeManagedFm({
        paths: { probe: gateway.probeDir },
        target: 'fm',
        binary: gateway.fm.binaryPath,
        socketPath: path.join(gateway.home, 'cli-probe.sock'),
        env: baseEnv(gateway.home),
        exec: fakeExec,
        samples: 1,
        onWarning: () => undefined,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ProbeInProgressError);
      expect(fs.existsSync(path.join(gateway.home, 'cli-probe.sock'))).toBe(false);
    });

    it('starts no probe in the gateway while another process holds the probe lock of the key, and starts one after it is released', async () => {
      const gateway = await setup();
      const held = await acquireProbeLock(gateway.probeDir, gateway.keyNow());

      expectProbing(await gateway.send(true));
      expect(gateway.measures).toEqual([]);

      held.release();
      expectProbing(await gateway.send(true));
      expect(gateway.measures).toHaveLength(1);
    });

    it('refuses a second holder of the same key in the same process', async () => {
      const gateway = await setup();
      const held = await acquireProbeLock(gateway.probeDir, gateway.keyNow());

      await expect(acquireProbeLock(gateway.probeDir, gateway.keyNow())).rejects.toBeInstanceOf(ProbeInProgressError);
      held.release();
    });
  });

  describe('P4 RecordSeenAtOnce', () => {
    it('serves the next request from the record as soon as the probe writes it, without a restart', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));

      gateway.measures[0]?.resolve(makeReport(1, 1));
      await until(gateway.recordExists, 'the probe record is written');

      const response = await gateway.send(false);
      expect(response.status).toBe(200);
      expect(gateway.measures).toHaveLength(1);
    });
  });

  describe('P5 FailedWritesNothing', () => {
    it('writes no record when the probe fails, and the next request starts a new probe', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));

      gateway.measures[0]?.reject(new Error('the fake probe failed'));
      await until(async () => {
        expectProbing(await gateway.send(false));
        return gateway.measures.length === 2;
      }, 'a second probe starts');

      expect(gateway.recordExists()).toBe(false);
    });
  });

  describe('P6 RecordMatchesKey', () => {
    it('computes the key per request, so an OS build change after the record starts a new probe for the new key', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));
      gateway.measures[0]?.resolve(makeReport(1, 1));
      await until(gateway.recordExists, 'the probe record is written');
      expect((await gateway.send(false)).status).toBe(200);

      gateway.os.build = '26B999';

      expectProbing(await gateway.send(false));
      expect(gateway.measures.map((measure) => measure.key.osBuild)).toEqual([FAKE_OS_BUILD, '26B999']);
    });
  });

  describe('P7 RecordIsClean', () => {
    it('discards a measurement during which the key changed, and the next request probes the new key', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));

      gateway.os.build = '26B999';
      gateway.measures[0]?.resolve(makeReport(1, 1));
      await until(async () => {
        expectProbing(await gateway.send(false));
        return gateway.measures.length === 2;
      }, 'a probe of the new key starts');

      expect(gateway.recordExists()).toBe(false);
      expect(gateway.measures[1]?.key.osBuild).toBe('26B999');
    });
  });
});
