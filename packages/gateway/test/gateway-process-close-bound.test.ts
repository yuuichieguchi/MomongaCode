import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FM_STOP_GRACE_MS, GATEWAY_CLOSE_GRACE_MS, GATEWAY_MAX_CLOSE_MS, REAP_POLL_INTERVAL_MS, adapterSocketPath, createJsonLogger, reapMarkedProcesses } from '@momonga/foundation';
import type { ProcessInspector } from '@momonga/foundation';
import { GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';
import type { FmChild } from '@momonga/gateway';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeClock, createFakeFm, createFakeTimers, drivenReapTiming, fakeExec, startFakeChatCompletions, waitFor } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeClock, FakeTimers } from '@momonga/testkit';
import { START_MS, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { saveFakeFmRecord } from './fm-record-support.ts';
import { advanceToNextWait, openUnreadStream } from './gateway-support.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';

const HOLDER_PID = 4343;
const HOLDER_STARTED_AT = 1_700_000_000_000;

const survivorInspector = (pgid: number): ProcessInspector => ({
  startTimeOf: async () => ({ kind: 'value', value: HOLDER_STARTED_AT }),
  holdersOf: async () => ({ kind: 'value', value: [HOLDER_PID] }),
  groupsOf: async (pids) => ({ kind: 'value', value: new Map(pids.map((pid) => [pid, pid === HOLDER_PID ? pgid : process.pid])) }),
  markerState: async () => 'held',
});

type ProbePhase = 'running' | 'waiting on health';

type FakeServes = { managed: FakeChatCompletionsServer[]; probe: FakeChatCompletionsServer[]; spawned: string[]; probeTerminatedAt: number[] };

const unkillableFmSpawn = (dir: string, clock: FakeClock, timers: FakeTimers, probePhase: ProbePhase, serves: FakeServes) => {
  let nextPid = 5000;
  return (_file: string, args: readonly string[]): FmChild => {
    const socketPath = args[2] ?? '';
    const isProbe = path.basename(socketPath).startsWith('fm-probe-');
    const pid = nextPid++;
    const marker = path.join(dir, `marker-${pid}`);
    fs.writeFileSync(marker, `${pid}\n`, { mode: 0o600 });
    serves.spawned.push(isProbe ? 'probe' : 'managed');
    void startFakeChatCompletions({
      scenario: 'tools-ok',
      socketPath,
      script: [{ kind: 'hang', chunks: isProbe ? [] : Array.from({ length: 80 }, () => ({ delta: { content: 'x'.repeat(100_000) } })) }],
      ...(isProbe && probePhase === 'waiting on health' ? { healthy: false } : {}),
    }).then((server) => (isProbe ? serves.probe : serves.managed).push(server));
    const events = new EventEmitter();
    return {
      kill: async (signal) => {
        if (isProbe && signal === 'SIGTERM') serves.probeTerminatedAt.push(clock.now());
        return true;
      },
      finalize: async (graceMs) => {
        await reapMarkedProcesses({
          marker,
          pgid: pid,
          killGraceMs: graceMs,
          label: 'fm',
          onWarning: () => undefined,
          kill: () => undefined,
          timing: drivenReapTiming(clock, timers),
          inspector: survivorInspector(pid),
        });
      },
      once: (event: 'exit' | 'error', listener: (...args: never[]) => void) => events.once(event, listener as (...args: unknown[]) => void),
    } as FmChild;
  };
};

const hostExec = async (file: string, args: readonly string[]) => {
  if (path.basename(file) === 'sw_vers') return { exitCode: 0, stdout: `${FAKE_OS_BUILD}\n`, stderr: '' };
  if (args[0] === 'license') return { exitCode: 0, stdout: 'Agreed', stderr: '' };
  if (args[0] === 'available') return { exitCode: 0, stdout: 'System model available', stderr: '' };
  return fakeExec(file, args);
};

const POLLS = new Set([REAP_POLL_INTERVAL_MS]);

const WAITS_OF_THE_CLOSE = new Set([GATEWAY_CLOSE_GRACE_MS, FM_STOP_GRACE_MS, REAP_POLL_INTERVAL_MS]);

type CloseOutcome = { tookMs: number; probeTerminatedAfterMs: number[] };

const closeWhileProbing = async (probePhase: ProbePhase): Promise<CloseOutcome> => {
  const dir = makeDir();
  const fm = await createFakeFm({ dir: makeDir() });
  const home = makeHome();
  writeSettings(home, {
    models: {
      aliases: { default: ['fm'], other: ['spare'] },
      targets: { fm: { adapter: 'fm' }, spare: { adapter: 'fm' } },
    },
  });
  await saveFakeFmRecord(home, 'fm', fm.binaryPath);
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const serves: FakeServes = { managed: [], probe: [], spawned: [], probeTerminatedAt: [] };
  registerCleanup(async () => {
    await Promise.all([...serves.managed, ...serves.probe].map((server) => server.close()));
  });
  const handle = await launchGateway({
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    fmBinary: fm.binaryPath,
    exec: hostExec,
    execWithStdin: async () => ({ exitCode: 0, stdout: '5\n', stderr: '' }),
    spawn: unkillableFmSpawn(dir, clock, timers, probePhase, serves),
    clock,
    timers,
    logger: createJsonLogger({ service: 'gateway', clock, stream: { write: () => true } }),
  });
  const client = clientFor(handle.socketPath);

  const unread = await openUnreadStream(handle.socketPath, { model: 'default', input: userInput('hello fm'), stream: true });
  registerCleanup(() => void unread.socket.destroy());
  const managedStreaming = (): boolean =>
    serves.managed.some((server) => server.requests.some((request) => request.path !== '/health')) &&
    timers.pending().some((timer) => timer.delayMs === GATEWAY_CONFIG_DEFAULTS.sseKeepAliveMs);
  while (!managedStreaming()) await advanceToNextWait(timers, POLLS, managedStreaming, 'the managed fm request to stream to a client that does not read');

  const probing = readJson(await postJson(client, '/v1/responses', { model: 'other', input: userInput('hello spare') }));
  expect((await probing).status).toBe(503);
  const probeReached = (): boolean =>
    probePhase === 'running'
      ? serves.probe.some((server) => server.requests.some((request) => request.path !== '/health'))
      : serves.probe.some((server) => server.requests.some((request) => request.path === '/health'));
  while (!probeReached()) await advanceToNextWait(timers, POLLS, probeReached, `the probe fm serve to be ${probePhase}`);

  const closeBegan = clock.now();
  let closed = false;
  const closing = handle.close().finally(() => {
    closed = true;
  });
  await waitFor(() => serves.probeTerminatedAt.length > 0, { description: 'the close to stop the probe fm serve before any of its waits' });
  while (!closed) await advanceToNextWait(timers, WAITS_OF_THE_CLOSE, () => closed, 'the next wait of the close');
  await closing;
  return { tookMs: clock.now() - closeBegan, probeTerminatedAfterMs: serves.probeTerminatedAt.map((at) => at - closeBegan) };
};

describe('the gateway process close bound with an fm probe in flight', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.each<[ProbePhase]>([['running'], ['waiting on health']])(
    'ends within GATEWAY_MAX_CLOSE_MS and stops the probe fm serve when the close begins, while the probe fm serve is %s and the managed fm serve streams to a client that does not read',
    async (phase) => {
      const outcome = await closeWhileProbing(phase);
      expect(outcome.tookMs).toBeLessThanOrEqual(GATEWAY_MAX_CLOSE_MS);
      expect(outcome.probeTerminatedAfterMs).toEqual([0]);
    },
  );
});
