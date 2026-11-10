import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBinaryHashCache, createJsonLogger, FIRST_GENERATION, managedInstancePaths, momongaPaths, readMarkerGroup } from '@momonga/foundation';
import { FM_SERVER, TARGET_NOT_READY, TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Probing } from '@momonga/protocol';
import type { KnownProbeKey } from '@momonga/config';
import * as gatewayModule from '@momonga/gateway';
import { ProbeInProgressError, acquireProbeLock, probeManagedFm } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeClock, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import type { FakeClock, FakeFmConfig } from '@momonga/testkit';
import { START_MS, getJson, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, isAlive, launchGateway, makeHome, until, writeSettings } from './gateway-process-helpers.ts';
import { readFileTool } from './cc-support.ts';
import { fmRecordKey } from './fm-record-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type ProbeServer = 'stall' | 'fail' | 'complete';

type SetupOptions = {
  toolCalling?: 'native';
  declared?: { contextWindow: number; maxOutputTokens: number };
  clock?: FakeClock;
  probe?: ProbeServer;
};

const STALL_EVERY_SAMPLE: NonNullable<FakeFmConfig['serve']> = { stallNativeSamples: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], stallMs: 600_000 };

const probeServeOf = (probe: ProbeServer): NonNullable<FakeFmConfig['serve']> => {
  if (probe === 'stall') return STALL_EVERY_SAMPLE;
  if (probe === 'fail') return { modelsReply: { kind: 'error', status: 500, body: { error: { message: 'the fake probe failed' } } } };
  return {};
};

type DumpRecord = { argv: string[]; pid: number };

const sha256Of = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const lockKeyOf = (key: KnownProbeKey): { target: string } & Record<string, string> => JSON.parse(key.canonical) as { target: string } & Record<string, string>;

const setup = async (options: SetupOptions = {}) => {
  const fm = await createFakeFm({ dir: makeDir() });
  const dumpFile = path.join(path.dirname(fm.binaryPath), 'argv.jsonl');
  fm.configure({ envDumpFile: dumpFile, serve: probeServeOf(options.probe ?? 'stall') });
  const home = makeHome();
  writeSettings(home, {
    models: {
      aliases: { default: ['fm'], other: ['spare'] },
      targets: {
        fm: {
          adapter: 'managed',
          server: 'fm',
          binary: fm.binaryPath,
          ...(options.toolCalling === undefined ? {} : { toolCalling: options.toolCalling }),
          ...(options.declared === undefined ? {} : { capabilities: options.declared }),
        },
        spare: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } },
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
  const logLines: string[] = [];
  const launched = (): DumpRecord[] =>
    fs.existsSync(dumpFile)
      ? fs
          .readFileSync(dumpFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as DumpRecord)
          .filter((record) => record.argv[0] === 'serve')
      : [];
  registerCleanup(() => killGroupsForCleanup(launched().map((record) => record.pid)));
  const probes = (): DumpRecord[] => launched().filter((record) => path.basename(record.argv[record.argv.indexOf('--socket') + 1] ?? '').startsWith('_probe-'));
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    exec,
    logger: createJsonLogger({ service: 'gateway', clock: options.clock ?? { now: () => Date.now() }, stream: { write: (line: string) => logLines.push(line) > 0 } }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const client = clientFor(handle.socketPath);
  const probeDir = path.join(home, '.momonga', 'state', 'probe');
  const keyNow = (): KnownProbeKey => fmRecordKey(sha256Of(fm.binaryPath), FAKE_OS_BUILD);
  const request = (withTools = false) => postJson(client, '/v1/responses', { model: 'default', input: userInput('hello fm'), ...(withTools ? { tools: [readFileTool] } : {}) });
  const send = async (withTools = false) => readJson(await request(withTools));
  const sendRaw = (withTools = false) => request(withTools);
  const recordFileOf = (key: KnownProbeKey): string => path.join(probeDir, `${key.digest}.json`);
  const recordExists = (): boolean => fs.existsSync(recordFileOf(keyNow()));
  const anyRecord = (): boolean => fs.existsSync(probeDir) && fs.readdirSync(probeDir).some((name) => name.endsWith('.json'));
  const replaceBinary = (): void => {
    fs.appendFileSync(fm.binaryPath, `\n// ${createHash('sha256').update(String(fs.statSync(fm.binaryPath).size)).digest('hex')}\n`);
  };
  return { fm, home, host, logLines, handle, client, probeDir, keyNow, send, sendRaw, recordExists, anyRecord, replaceBinary, probes };
};

const expectProbing = (response: { status: number; body: { error: { code: string; message: string } } }): void => {
  expect(response.status).toBe(503);
  expect(response.body.error.code).toBe(TARGET_PROBING);
  expect(response.body.error.message).toContain(TARGET_PROBING_MESSAGE);
};

const probeStarted = (gateway: Awaited<ReturnType<typeof setup>>, count = 1) => until(() => gateway.probes().length === count, `probe fm serve number ${count} to start`);

describe('the automatic probe of an fm target with no probe record', () => {
  describe('P3 NoRecordGets503 and RetryAfterIsHonest', () => {
    it('answers a request with tools 503 target_probing with Retry-After, never 412, and starts the probe for the current key', async () => {
      const gateway = await setup();

      const raw = await gateway.sendRaw(true);
      const response = await readJson(raw);

      expectProbing(response);
      expect(raw.headers['retry-after']).toBe('120');
      await probeStarted(gateway);
      await expect(acquireProbeLock(gateway.probeDir, lockKeyOf(gateway.keyNow()), 'fm')).rejects.toBeInstanceOf(ProbeInProgressError);
    });
  });

  describe('P2 NoGuessedAnswer', () => {
    it('answers a request without tools 503 target_probing instead of serving it from a guessed context window', async () => {
      const gateway = await setup();

      expectProbing(await gateway.send(false));
      await probeStarted(gateway);
    });

    it('starts the probe for a target that declares its tool calling but not its context window', async () => {
      const gateway = await setup({ toolCalling: 'native' });

      expectProbing(await gateway.send(false));
      await probeStarted(gateway);
    });

    it('starts no probe for a target that declares its tool calling, context window and output bound, and serves it from the declaration', async () => {
      const gateway = await setup({ toolCalling: 'native', declared: { contextWindow: 8192, maxOutputTokens: 1024 }, probe: 'complete' });

      const response = await gateway.send(false);

      expect(response.status).toBe(200);
      expect(gateway.probes()).toEqual([]);
      const listing = await getJson(gateway.client, '/v1/momonga/models');
      const entry = (listing.body as { data: Array<{ id: string; capabilities: { contextWindow: number; source: string } }> }).data.find((model) => model.id === 'default');
      expect(entry?.capabilities).toMatchObject({ contextWindow: 8192, source: 'declared' });
    });

    it('keeps no guessed context window or output bound in the managed target', () => {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'managed', 'target.ts'), 'utf8');

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
      await probeStarted(gateway);
      expectProbing(await gateway.send(false));
      expect(gateway.probes()).toHaveLength(1);
    });

    it('refuses the momonga gateway probe command while the gateway measures the same key, without starting fm', async () => {
      const gateway = await setup();
      expectProbing(await gateway.send(true));
      await probeStarted(gateway);
      const paths = momongaPaths(gateway.home, process.platform, {});
      const instance = managedInstancePaths(paths, { owner: 'cli', purpose: 'probe', target: 'fm' } as Parameters<typeof managedInstancePaths>[1]);

      const failure = await probeManagedFm({
        platform: process.platform,
        paths,
        instance,
        description: FM_SERVER,
        target: 'fm',
        binary: gateway.fm.binaryPath,
        readyTimeoutMs: FM_SERVER.ready.limitMs,
        env: baseEnv(gateway.home),
        exec: fakeExec,
        samples: 1,
        signal: new AbortController().signal,
        hashes: createBinaryHashCache(),
        isUsableBinary: async () => true,
        readStopGraceMs: () => 1_000,
        onWarning: () => undefined,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ProbeInProgressError);
      expect(fs.existsSync(instance.socketPath)).toBe(false);
    });

    it('starts no probe in the gateway while another process holds the probe lock of the key, and starts one after it is released', async () => {
      const gateway = await setup();
      const held = await acquireProbeLock(gateway.probeDir, lockKeyOf(gateway.keyNow()), 'fm');

      expectProbing(await gateway.send(true));
      expect(gateway.probes()).toEqual([]);

      held.release();
      expectProbing(await gateway.send(true));
      await probeStarted(gateway);
    });

    it('refuses a second holder of the same key in the same process', async () => {
      const gateway = await setup();
      const held = await acquireProbeLock(gateway.probeDir, lockKeyOf(gateway.keyNow()), 'fm');

      await expect(acquireProbeLock(gateway.probeDir, lockKeyOf(gateway.keyNow()), 'fm')).rejects.toBeInstanceOf(ProbeInProgressError);
      held.release();
    });
  });

  describe('P4 RecordSeenAtOnce', () => {
    it('serves the next request from the record as soon as the probe writes it, without a restart', async () => {
      const gateway = await setup({ probe: 'complete' });
      expectProbing(await gateway.send(false));

      await until(gateway.recordExists, 'the probe record is written');
      const response = await gateway.send(false);
      expect(response.status).toBe(200);
      expect(gateway.probes()).toHaveLength(1);
    });
  });

  describe('P5 FailedWritesNothing and P9 NoProbeInBackoff', () => {
    it('writes no record when the probe fails, answers 503 with the remaining interval inside it, and starts the next probe only after one Retry-After interval', async () => {
      const clock = createFakeClock(START_MS);
      const gateway = await setup({ clock, probe: 'fail' });
      expectProbing(await gateway.send(false));

      await until(() => gateway.logLines.some((line) => line.includes('failed and recorded nothing')), 'the failure is logged');
      clock.advance(30_000);

      const inside = await gateway.sendRaw(false);
      expectProbing(await readJson(inside));
      expect(inside.headers['retry-after']).toBe('90');
      expect(gateway.probes()).toHaveLength(1);
      expect(gateway.anyRecord()).toBe(false);

      clock.advance(90_000);
      expectProbing(await gateway.send(false));
      await probeStarted(gateway, 2);
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
      expect(gateway.probes()).toEqual([]);

      gateway.host.licenseExit = 0;
      expectProbing(await gateway.send(false));
      await probeStarted(gateway);
    });
  });

  describe('P6 RecordMatchesKey', () => {
    it('sees a replaced binary at the next request through its file identity, and probes the new key', async () => {
      const gateway = await setup({ probe: 'complete' });
      expectProbing(await gateway.send(false));
      await until(gateway.recordExists, 'the probe record is written');
      expect((await gateway.send(false)).status).toBe(200);
      const before = gateway.keyNow();

      gateway.replaceBinary();

      expect(gateway.keyNow().digest).not.toBe(before.digest);
      expectProbing(await gateway.send(false));
      await until(gateway.recordExists, 'the probe record of the new key is written');
      expect(gateway.probes()).toHaveLength(2);
    });

    it('runs no subprocess per request: the OS build is read once for a server instance, and the counter reads the same key', async () => {
      const gateway = await setup({ probe: 'complete' });
      expectProbing(await gateway.send(false));
      await until(gateway.recordExists, 'the probe record is written');
      const afterProbe = gateway.host.swVersCalls;

      for (let index = 0; index < 3; index += 1) expect((await gateway.send(false)).status).toBe(200);
      await getJson(gateway.client, '/v1/momonga/models');

      expect(gateway.host.swVersCalls).toBe(afterProbe);
    });
  });

  describe('P7 RecordIsClean', () => {
    it('discards a measurement during which the binary changed, and the next request probes the new key', async () => {
      const gateway = await setup({ probe: 'complete' });
      gateway.fm.configure({ serve: { stallNativeSamples: [0], stallMs: 1_000 } });
      expectProbing(await gateway.send(false));
      await probeStarted(gateway);
      const before = gateway.keyNow();

      gateway.replaceBinary();
      await until(() => gateway.logLines.some((line) => line.includes('failed and recorded nothing')), 'the measurement of the old key is discarded');

      expect(fs.existsSync(path.join(gateway.probeDir, `${before.digest}.json`))).toBe(false);
      expectProbing(await gateway.send(false));
      await probeStarted(gateway, 2);
    });
  });

  describe('a stop that is not a failure', () => {
    it('starts the probe fm serve under its generation marker directory, stops it with the gateway, and logs the probe as stopped, not failed', async () => {
      const gateway = await setup();
      const markers = path.join(gateway.home, '.momonga', 'run', 'markers', `g${FIRST_GENERATION}`, 'targets', '_probe-fm');

      expectProbing(await gateway.send(false));
      const markerFile = (): string | undefined => {
        if (!fs.existsSync(markers)) return undefined;
        const entries = fs.readdirSync(markers);
        return entries.length === 1 ? path.join(markers, entries[0] as string) : undefined;
      };
      await until(async () => {
        const file = markerFile();
        return file !== undefined && (await readMarkerGroup(file)) !== undefined;
      }, 'the probe marker records the process group of the probe fm serve');
      const pgid = await readMarkerGroup(markerFile() as string);
      if (pgid === undefined) throw new Error('the probe marker records no process group');
      registerCleanup(() => killGroupsForCleanup([pgid]));

      await gateway.handle.close();

      expect(isAlive(pgid)).toBe(false);
      expect(fs.readdirSync(markers)).toEqual([]);
      expect(gateway.logLines.some((line) => line.includes('the automatic probe of the target fm was stopped'))).toBe(true);
      expect(gateway.logLines.some((line) => line.includes('failed and recorded nothing'))).toBe(false);
    });
  });
});

type Report = { contextWindow: number };
type Ensured = { kind: 'probing'; probing: Probing } | { kind: 'measured'; report: Report };
type InstanceProbe = { ensure(): Promise<Ensured>; restarted(): void; close(): Promise<void> };
type InstanceProbeOptions = {
  target: string;
  unknown: { component: string; reason: string };
  dir: string;
  measure: (signal: AbortSignal) => Promise<Report>;
  retryAfterMs: number;
  onNotice: (text: string) => void;
};

const createInstanceProbe = (options: InstanceProbeOptions): InstanceProbe => {
  const value = (gatewayModule as Record<string, unknown>)['createInstanceProbe'];
  if (value === undefined) throw new Error('@momonga/gateway does not export createInstanceProbe');
  return (value as (options: InstanceProbeOptions) => InstanceProbe)(options);
};

const RETRY_AFTER_MS = 120_000;
const REASON = 'sw_vers is not on PATH';
const NOTICE = `the target "apple": its probe key needs the OS build, which cannot be read: ${REASON}; it is measured each time its server starts and no probe record is kept`;

const deferredReport = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const setupInstance = () => {
  const dir = makeDir();
  const notices: string[] = [];
  const pending: Array<ReturnType<typeof deferredReport<Report>>> = [];
  const probe = createInstanceProbe({
    target: 'apple',
    dir,
    unknown: { component: 'hostOsBuild', reason: REASON },
    measure: () => {
      const next = deferredReport<Report>();
      pending.push(next);
      return next.promise;
    },
    retryAfterMs: RETRY_AFTER_MS,
    onNotice: (text) => notices.push(text),
  });
  return { probe, notices, pending, dir };
};

const settleRounds = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('P11 NoRecordUnderUnknown and P12 MemoryIsThisInstance: a probe key component that cannot be read (design-managed-servers section 17, item 10)', () => {
  it('P11 NoRecordUnderUnknown: reads and writes no record and takes no record lock in the probe directory, before or after the measurement', async () => {
    const { probe, pending, dir } = setupInstance();
    await probe.ensure();
    pending[0]?.resolve({ contextWindow: 4096 });
    await settleRounds();
    await probe.ensure();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('answers the first request with the D5 probing answer and starts one measurement of the running instance', async () => {
    const { probe, pending } = setupInstance();
    expect(await probe.ensure()).toEqual({ kind: 'probing', probing: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 } });
    expect(pending).toHaveLength(1);
  });

  it('says once per instance, in English, which component cannot be read and that no record is kept', async () => {
    const { probe, notices } = setupInstance();
    await probe.ensure();
    await probe.ensure();
    expect(notices).toEqual([NOTICE]);
  });

  it('runs one measurement while requests keep arriving', async () => {
    const { probe, pending } = setupInstance();
    await probe.ensure();
    expect((await probe.ensure()).kind).toBe('probing');
    expect(pending).toHaveLength(1);
  });

  it('P12 MemoryIsThisInstance: serves from the in-memory result of this instance once the measurement ends', async () => {
    const { probe, pending } = setupInstance();
    await probe.ensure();
    pending[0]?.resolve({ contextWindow: 4096 });
    await settleRounds();
    expect(await probe.ensure()).toEqual({ kind: 'measured', report: { contextWindow: 4096 } });
    expect(pending).toHaveLength(1);
  });

  it('P12 MemoryIsThisInstance: measures again, and says so again, when its server starts again', async () => {
    const { probe, pending, notices } = setupInstance();
    await probe.ensure();
    pending[0]?.resolve({ contextWindow: 4096 });
    await settleRounds();
    probe.restarted();
    expect((await probe.ensure()).kind).toBe('probing');
    expect(pending).toHaveLength(2);
    expect(notices).toEqual([NOTICE, NOTICE]);
  });
});
