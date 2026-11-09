import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATEWAY_MAX_CLOSE_MS, REAP_POLL_INTERVAL_MS, fmServeStopBoundMs, reapMarkedProcesses } from '@momonga/foundation';
import type { ProcessInspector } from '@momonga/foundation';
import { FM_SERVE_DEFAULTS, GATEWAY_CONFIG_DEFAULTS, createFmServe } from '@momonga/gateway';
import type { FmChild, FmServeTimers } from '@momonga/gateway';
import { drivenReapTiming, startFakeChatCompletions, waitFor } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeClock, FakeTimers } from '@momonga/testkit';
import { makeDir, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents, createHangingAdapter, openUnreadStream } from './gateway-support.ts';

describe('gateway close budget', () => {
  it('GATEWAY_MAX_CLOSE_MS is the close grace plus the fm stop bound at the default stop grace', () => {
    expect(GATEWAY_MAX_CLOSE_MS).toBe(GATEWAY_CONFIG_DEFAULTS.closeGraceMs + fmServeStopBoundMs(FM_SERVE_DEFAULTS.stopGraceMs));
  });
});

const FM_PID = 4242;
const HOLDER_PID = 4343;
const HOLDER_STARTED_AT = 1_700_000_000_000;

const survivorInspector: ProcessInspector = {
  startTimeOf: async () => ({ kind: 'value', value: HOLDER_STARTED_AT }),
  holdersOf: async () => ({ kind: 'value', value: [HOLDER_PID] }),
  groupsOf: async (pids) => ({ kind: 'value', value: new Map(pids.map((pid) => [pid, pid === HOLDER_PID ? FM_PID : process.pid])) }),
  markerState: async () => 'held',
};

type SwitchableTimers = FmServeTimers & { useFake(): void };

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

const unkillableFmChild = (socketPath: string, marker: string, clock: FakeClock, timers: FakeTimers, servers: FakeChatCompletionsServer[]): FmChild => {
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
  } as FmChild;
};

describe('the gateway close bound against a gateway that holds an fm serve at the default grace', () => {
  it('covers the close grace, both stopGraceMs waits of the fm stop and the grace windows of its finalize reap', async () => {
    const dir = makeDir();
    const marker = path.join(dir, 'fm-marker');
    fs.writeFileSync(marker, `${FM_PID}\n`, { mode: 0o600 });
    const servers: FakeChatCompletionsServer[] = [];
    registerCleanup(async () => {
      await Promise.all(servers.map((server) => server.close()));
    });
    const primary = createHangingAdapter(bigTextEvents(80, 100_000));
    const harness = await startGateway({ adapters: { primary }, config: { closeGraceMs: GATEWAY_CONFIG_DEFAULTS.closeGraceMs }, dir });
    const fmTimers = switchableTimers(harness.timers);
    const serve = createFmServe({
      ...FM_SERVE_DEFAULTS,
      binary: '/usr/bin/fm',
      socketPath: path.join(dir, 'fm.sock'),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      spawn: () => unkillableFmChild(path.join(dir, 'fm.sock'), marker, harness.clock, harness.timers, servers),
      timers: fmTimers,
      onWarning: () => undefined,
    });
    primary.close = () => serve.stop();
    await serve.start();
    fmTimers.useFake();

    await openUnreadStream(harness.socketPath, { model: 'fast', input: userInput('hi'), stream: true });
    await waitFor(() => primary.pulled.count >= 5, { description: 'adapter streaming' });

    const closeBegan = harness.clock.now();
    let closed = false;
    const closing = harness.gateway.close().finally(() => {
      closed = true;
    });
    const waits = new Set([GATEWAY_CONFIG_DEFAULTS.closeGraceMs, FM_SERVE_DEFAULTS.stopGraceMs, REAP_POLL_INTERVAL_MS]);
    while (!closed) {
      await waitFor(() => closed || harness.timers.pending().some((timer) => waits.has(timer.delayMs)), { description: 'the next wait of the close' });
      const next = harness.timers.pending().find((timer) => waits.has(timer.delayMs));
      if (!closed && next !== undefined) harness.timers.advance(next.dueAt - harness.clock.now());
    }
    await closing;

    expect(harness.clock.now() - closeBegan).toBeLessThanOrEqual(GATEWAY_MAX_CLOSE_MS);
  });
});
