import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '@momonga/foundation';
import { TARGET_NOT_READY, TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { ProbeReport } from '@momonga/protocol';
import { ProbeInProgressError, acquireProbeLock, probeManagedFm } from '@momonga/gateway';
import type { ProbeRecordKey } from '@momonga/gateway';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeClock, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { START_MS, getJson, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';
import { PROCESS_VERSION, baseEnv, clientFor, isAlive, launchGateway, makeHome, until, writeSettings } from './gateway-process-helpers.ts';
import { readFileTool } from './cc-support.ts';

type Measure = { key: ProbeRecordKey; signal: AbortSignal; resolve: (report: ProbeReport) => void; reject: (error: Error) => void };

type SetupOptions = {
  toolCalling?: 'native';
  declared?: { contextWindow: number; maxOutputTokens: number };
  clock?: FakeClock;
  realMeasure?: true;
};

const sha256Of = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const setup = async (options: SetupOptions = {}) => {
  const fm = await createFakeFm({ dir: makeDir() });
  const home = makeHome();
  writeSettings(home, {
    models: {
      aliases: { default: ['fm'], other: ['spare'] },
      targets: {
        fm: {
          adapter: 'fm',
          ...(options.toolCalling === undefined ? {} : { toolCalling: options.toolCalling }),
          ...(options.declared === undefined ? {} : { capabilities: options.declared }),
        },
        spare: { adapter: 'fm', toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } },
      },
    },
  });
  const host = { licenseExit: 0, swVersCalls: 0 };
  const exec = async (file: string, args: readonly string[]) => {
    if (path.basename(file) === 'sw_vers') {
      host.swVersCalls += 1;
      return { exitCode: 0, stdout: `${FAKE_OS_BUILD}\n`, stderr: '' };
    }
    if (args[0] === 'license') {
      return host.licenseExit === 0 ? { exitCode: 0, stdout: 'Agreed', stderr: '' } : { exitCode: host.licenseExit, stdout: '', stderr: 'The license agreement has not been accepted.' };
    }
    if (args[0] === 'available') return { exitCode: 0, stdout: 'System model available', stderr: '' };
    return fakeExec(file, args);
  };
  const measures: Measure[] = [];
  const logLines: string[] = [];
  const handle = await launchGateway({
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    fmBinary: fm.binaryPath,
    exec,
    logger: createJsonLogger({ service: 'gateway', clock: options.clock ?? { now: () => Date.now() }, stream: { write: (line: string) => logLines.push(line) } }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.realMeasure === true
      ? {}
      : {
          measureFm: ({ key, signal }: { key: ProbeRecordKey; signal: AbortSignal }) =>
            new Promise<ProbeReport>((resolve, reject) => {
              measures.push({ key, signal, resolve, reject });
            }),
        }),
  });
  const client = clientFor(handle.socketPath);
  const probeDir = path.join(home, '.momonga', 'state', 'probe');
  const keyNow = (target = 'fm'): ProbeRecordKey => ({ target, binarySha256: sha256Of(fm.binaryPath), osBuild: FAKE_OS_BUILD });
  const request = (withTools = false) => postJson(client, '/v1/responses', { model: 'default', input: userInput('hello fm'), ...(withTools ? { tools: [readFileTool] } : {}) });
  const send = async (withTools = false) => readJson(await request(withTools));
  const sendRaw = (withTools = false) => request(withTools);
  const recordFile = path.join(probeDir, 'fm.json');
  const recordExists = (): boolean => fs.existsSync(recordFile);
  const replaceBinary = (): void => {
    fs.appendFileSync(fm.binaryPath, `\n// ${Math.random()}\n`);
  };
  return { fm, home, host, measures, logLines, handle, client, probeDir, keyNow, send, sendRaw, recordFile, recordExists, replaceBinary };
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
      expect(raw.headers['retry-after']).toBe('120');
      expect(gateway.measures.map((measure) => measure.key)).toEqual([gateway.keyNow()]);
    });
  });

  describe('P2 NoGuessedAnswer', () => {
    it('answers a request without tools 503 target_probing instead of serving it from a guessed context window', async () => {
      const gateway = await setup();

      expectProbing(await gateway.send(false));
      expect(gateway.measures).toHaveLength(1);
    });

    it('starts the probe for a target that declares its tool calling but not its context window', async () => {
      const gateway = await setup({ toolCalling: 'native' });

      expectProbing(await gateway.send(false));
      expect(gateway.measures).toHaveLength(1);
    });

    it('starts no probe for a target that declares its tool calling, context window and output bound, and serves it from the declaration', async () => {
      const gateway = await setup({ toolCalling: 'native', declared: { contextWindow: 8192, maxOutputTokens: 1024 } });

      const response = await gateway.send(false);

      expect(response.status).toBe(200);
      expect(gateway.measures).toEqual([]);
      const listing = await getJson(gateway.client, '/v1/momonga/models');
      const entry = (listing.body as { data: Array<{ id: string; capabilities: { contextWindow: number; source: string } }> }).data.find((model) => model.id === 'default');
      expect(entry?.capabilities).toMatchObject({ contextWindow: 8192, source: 'declared' });
    });

    it('keeps no guessed context window or output bound in the fm target', () => {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'managed', 'fm-target.ts'), 'utf8');

      expect(source).not.toMatch(/UNPROBED_CONTEXT_WINDOW|UNPROBED_MAX_OUTPUT_TOKENS|\b4096\b|\b1024\b/);
    });

    it('lists a probing alias with the probing readiness state and no capability numbers, and still lists the other aliases', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));

      const listing = await getJson(gateway.client, '/v1/momonga/models');

      expect(listing.status).toBe(200);
      const entries = (listing.body as { data: Array<Record<string, unknown>> }).data;
      const probing = entries.find((entry) => entry['id'] === 'default');
      expect(probing?.['capabilities']).toEqual({ toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 }, source: 'unprobed' });
      expect(probing).not.toHaveProperty('probing');
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

  describe('P5 FailedWritesNothing and P9 NoProbeInBackoff', () => {
    it('writes no record when the probe fails, answers 503 with the remaining interval inside it, and starts the next probe only after one Retry-After interval', async () => {
      const clock = createFakeClock(START_MS);
      const gateway = await setup({ clock });
      expectProbing(await gateway.send(false));

      gateway.measures[0]?.reject(new Error('the fake probe failed'));
      await until(() => gateway.logLines.some((line) => line.includes('failed and recorded nothing')), 'the failure is logged');
      clock.advance(30_000);

      const inside = await gateway.sendRaw(false);
      expectProbing(await readJson(inside));
      expect(inside.headers['retry-after']).toBe('90');
      expect(gateway.measures).toHaveLength(1);
      expect(gateway.recordExists()).toBe(false);

      clock.advance(90_000);
      expectProbing(await gateway.send(false));
      expect(gateway.measures).toHaveLength(2);
    });
  });

  describe('P8 RefusalGetsRemedy', () => {
    it('answers 412 target_not_ready with the fm remedy at once when the licence is not agreed, starts no probe, remembers nothing, and probes once it is agreed', async () => {
      const gateway = await setup();
      gateway.host.licenseExit = 69;

      const refused = await gateway.send(false);

      expect(refused.status).toBe(412);
      expect(refused.body.error.code).toBe(TARGET_NOT_READY);
      expect(refused.body.error.message).toContain('sudo fm license');
      expect(gateway.measures).toEqual([]);

      gateway.host.licenseExit = 0;
      expectProbing(await gateway.send(false));
      expect(gateway.measures).toHaveLength(1);
    });
  });

  describe('P6 RecordMatchesKey', () => {
    it('sees a replaced binary at the next request through its file identity, and probes the new key', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));
      gateway.measures[0]?.resolve(makeReport(1, 1));
      await until(gateway.recordExists, 'the probe record is written');
      expect((await gateway.send(false)).status).toBe(200);
      const before = gateway.keyNow();

      gateway.replaceBinary();

      expectProbing(await gateway.send(false));
      expect(gateway.measures.map((measure) => measure.key.binarySha256)).toEqual([before.binarySha256, gateway.keyNow().binarySha256]);
    });

    it('runs no subprocess per request: the OS build is read once for a binary file identity, and the counter reads the same key', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));
      gateway.measures[0]?.resolve(makeReport(1, 1));
      await until(gateway.recordExists, 'the probe record is written');
      const afterStart = gateway.host.swVersCalls;

      for (let index = 0; index < 3; index += 1) expect((await gateway.send(false)).status).toBe(200);
      await getJson(gateway.client, '/v1/momonga/models');

      expect(afterStart).toBe(1);
      expect(gateway.host.swVersCalls).toBe(1);
      gateway.replaceBinary();
      expectProbing(await gateway.send(false));
      expect(gateway.host.swVersCalls).toBe(2);
    });
  });

  describe('P7 RecordIsClean', () => {
    it('discards a measurement during which the binary changed, and the next request probes the new key', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(false));

      gateway.replaceBinary();
      gateway.measures[0]?.resolve(makeReport(1, 1));
      await until(async () => {
        const response = await gateway.send(false);
        expect(response.status).toBe(503);
        return gateway.measures.length === 2;
      }, 'a probe of the new key starts');

      expect(gateway.recordExists()).toBe(false);
      expect(gateway.measures[1]?.key.binarySha256).toBe(gateway.keyNow().binarySha256);
    });
  });

  describe('a stop that is not a failure', () => {
    it('starts the probe fm serve under the marker directory, stops it with the gateway, and logs the probe as stopped, not failed', async () => {
      const gateway = await setup({ realMeasure: true });
      gateway.fm.configure({ serve: { stallNativeSamples: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], stallMs: 600_000 } });
      const markers = path.join(gateway.home, '.momonga', 'run', 'markers', 'targets', 'fm-probe-fm');

      expectProbing(await gateway.send(false));
      await until(() => fs.existsSync(markers) && fs.readdirSync(markers).length === 1, 'the probe fm serve is marked');
      const pid = Number(fs.readFileSync(path.join(markers, fs.readdirSync(markers)[0] as string), 'utf8').trim());
      registerCleanup(() => killGroupsForCleanup([pid]));

      await gateway.handle.close();

      expect(isAlive(pid)).toBe(false);
      expect(fs.readdirSync(markers)).toEqual([]);
      expect(gateway.logLines.some((line) => line.includes('the automatic probe of the target fm was stopped'))).toBe(true);
      expect(gateway.logLines.some((line) => line.includes('failed and recorded nothing'))).toBe(false);
    });
  });
});
