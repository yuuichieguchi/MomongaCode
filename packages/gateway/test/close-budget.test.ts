import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, KILL_CONFIRM_MS, REAP_POLL_INTERVAL_MS, gatewayMaxCloseMs, managedServerStopBoundMs, reapMarkedProcesses } from '@momonga/foundation';
import type { ProcessInspector } from '@momonga/foundation';
import { GATEWAY_CONFIG_DEFAULTS, createManagedServer } from '@momonga/gateway';
import type { ManagedChild, ManagedServerTimers } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, drivenReapTiming, startFakeChatCompletions, waitFor } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeClock, FakeTimers } from '@momonga/testkit';
import { makeDir, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { advanceToNextWait, bigTextEvents, createHangingAdapter, openUnreadStream } from './gateway-support.ts';
import { FM_SERVER } from '@momonga/protocol';

describe('gateway close budget', () => {
  it('the gateway close at the default stop values is the close grace plus the managed-server stop bound at the default stop grace', () => {
    expect(gatewayMaxCloseMs(DEFAULT_STOP_VALUES)).toBe(GATEWAY_CONFIG_DEFAULTS.closeGraceMs + managedServerStopBoundMs(DEFAULT_STOP_VALUES.managedServerStopGraceMs));
  });
});

const FM_PID = 4242;
const HOLDER_PID = 4343;
const HOLDER_STARTED_AT = 1_700_000_000_000n;

const survivorInspector: ProcessInspector = {
  startTimeOf: async () => ({ kind: 'value', value: HOLDER_STARTED_AT }),
  holdersOf: async () => ({ kind: 'value', value: [HOLDER_PID] }),
  groupsOf: async (pids) => ({ kind: 'value', value: new Map(pids.map((pid) => [pid, pid === HOLDER_PID ? FM_PID : process.pid])) }),
  markerState: async () => 'held',
};

type SwitchableTimers = ManagedServerTimers & { useFake(): void };

const switchableTimers = (fake: FakeTimers): SwitchableTimers => {
  let virtual = false;
  const real = new Set<unknown>();
  return {
    setTimeout: (callback, ms) => {
      if (virtual) return fake.setTimeout(callback, ms);
      const handle = setTimeout(callback, ms);
      real.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (real.delete(handle)) clearTimeout(handle as NodeJS.Timeout);
      else fake.clearTimeout(handle);
    },
    now: () => fake.now(),
    useFake: () => {
      virtual = true;
    },
  };
};

const unkillableManagedChild = (socketPath: string, marker: string, clock: FakeClock, timers: FakeTimers, servers: FakeChatCompletionsServer[]): ManagedChild => {
  const events = new EventEmitter();
  void startFakeChatCompletions({ scenario: 'tools-ok', socketPath }).then((server) => servers.push(server));
  return {
    kill: async () => true,
    finalize: async (graceMs) => {
      await reapMarkedProcesses({
        marker,
        pgid: FM_PID,
        killGraceMs: graceMs,
        label: 'fm',
        onWarning: () => undefined,
        kill: () => undefined,
        timing: drivenReapTiming(clock, timers),
        inspector: survivorInspector,
      });
    },
    once: (event: 'exit' | 'error', listener: (...args: never[]) => void) => events.once(event, listener as (...args: unknown[]) => void),
  } as ManagedChild;
};

describe('the gateway close bound against a gateway that holds an fm serve at the default grace', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('covers the close grace, both stopGraceMs waits of the fm stop and the grace windows of its finalize reap', async () => {
    const dir = makeDir();
    const marker = path.join(dir, 'fm-marker');
    fs.writeFileSync(marker, `${FM_PID}\n`, { mode: 0o600 });
    const servers: FakeChatCompletionsServer[] = [];
    registerCleanup(async () => {
      await Promise.all(servers.map((server) => server.close()));
    });
    const primary = createHangingAdapter(bigTextEvents(80, 100_000));
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { closeGraceMs: GATEWAY_CONFIG_DEFAULTS.closeGraceMs }, dir });
    const fmTimers = switchableTimers(harness.timers);
    const serve = createManagedServer({
      description: FM_SERVER,
      target: 'fm',
      lockPath: path.join(dir, 'fm.lock'),
      readyTimeoutMs: FM_SERVER.ready.limitMs,
      readStopGraceMs: () => DEFAULT_STOP_VALUES.managedServerStopGraceMs,
      binary: '/usr/bin/fm',
      socketPath: path.join(dir, 'fm.sock'),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      spawn: () => unkillableManagedChild(path.join(dir, 'fm.sock'), marker, harness.clock, harness.timers, servers),
      timers: fmTimers,
      onWarning: () => undefined,
    });
    primary.close = () => serve.stop();
    await serve.start();
    fmTimers.useFake();

    await openUnreadStream(harness.socketPath, { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true });
    await waitFor(() => primary.pulled.count >= 5, { description: 'adapter streaming' });

    const closeBegan = harness.clock.now();
    let closed = false;
    const closing = harness.gateway.close().finally(() => {
      closed = true;
    });
    const waits = new Set([GATEWAY_CONFIG_DEFAULTS.closeGraceMs, DEFAULT_STOP_VALUES.managedServerStopGraceMs, REAP_POLL_INTERVAL_MS, KILL_CONFIRM_MS]);
    while (!closed) await advanceToNextWait(harness.timers, waits, () => closed, 'the next wait of the close');
    await closing;

    expect(harness.clock.now() - closeBegan).toBeLessThanOrEqual(gatewayMaxCloseMs(DEFAULT_STOP_VALUES));
  });
});
