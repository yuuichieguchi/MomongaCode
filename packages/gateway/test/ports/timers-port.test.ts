import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_REQUEST_TIMEOUT_MS, FIRST_GENERATION, SWEEP_INTERVAL_MS } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, fakeExec } from '@momonga/testkit';
import { watchContent } from '../../src/adapters/shared/content-idle.ts';
import { UpstreamStall } from '../../src/adapters/shared/failures.ts';
import { createGatewayTimers } from '../../src/process-ports.ts';
import { getJson, makeDir, registerCleanup, switchableRole } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, modelsOf, until, writeSettings } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const NODE_TIMER_LIMIT_MS = 2_147_483_647;

const portOverFakeHost = () => {
  const clock = createFakeClock(1_000);
  const host = createFakeTimers(clock);
  const released: unknown[] = [];
  const timers = createGatewayTimers({ setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, release: (handle) => void released.push(handle) });
  return { clock, host, timers, released };
};

describe('the timer port of the gateway (gateway-core-C16)', () => {
  it('fires a delay above the Node limit after the whole delay, by chained host timers', () => {
    const { host, timers } = portOverFakeHost();
    const delayMs = NODE_TIMER_LIMIT_MS + 6;
    let fired = 0;
    timers.setTimeout(() => void (fired += 1), delayMs);

    host.advance(1);
    expect(fired).toBe(0);
    host.advance(delayMs - 2);
    expect(fired).toBe(0);
    host.advance(1);
    expect(fired).toBe(1);
    expect(host.pending()).toEqual([]);
  });

  it('clears a chained timer in any link of its chain', () => {
    const { host, timers } = portOverFakeHost();
    let fired = 0;
    const handle = timers.setTimeout(() => void (fired += 1), NODE_TIMER_LIMIT_MS + 6);
    host.advance(NODE_TIMER_LIMIT_MS);
    timers.clearTimeout(handle);

    expect(host.pending()).toEqual([]);
    host.advance(100);
    expect(fired).toBe(0);
  });

  it('gives a timeout signal that aborts with a TimeoutError at its delay and does not hold the process', () => {
    const { host, timers, released } = portOverFakeHost();
    const signal = timers.timeoutSignal(250);

    expect(released).toHaveLength(1);
    host.advance(249);
    expect(signal.aborted).toBe(false);
    host.advance(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
  });

  it('gives a timeout signal from the fake timers of the test kit', () => {
    const timers = createFakeTimers(createFakeClock(0));
    const signal = timers.timeoutSignal(40);

    timers.advance(39);
    expect(signal.aborted).toBe(false);
    timers.advance(1);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
  });
});

describe('the gateway reaches timers and process facts only through its ports (gateway-core-C16)', () => {
  it('stops a silent upstream from the injected timers', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const watch = watchContent({ headersTimeoutMs: 1_000, idleTimeoutMs: 70, timers });
    const silent: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => undefined) }) };
    const reading = watch.source(silent).next();

    timers.advance(70);

    await expect(reading).rejects.toBeInstanceOf(UpstreamStall);
    watch.dispose();
  });

  it('bounds the runtime health read of a retiring gateway by the injected timers, and reports the process id of its ports', async () => {
    const socketPath = path.join(makeDir(), 'up.sock');
    const upstream = http.createServer(() => undefined);
    await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
    registerCleanup(() => {
      upstream.closeAllConnections();
      upstream.close();
    });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: ccTarget(socketPath, { toolCalling: 'native' }) }) });
    const clock = createFakeClock(Date.now());
    const timers = createFakeTimers(clock);
    const role = switchableRole('serving');
    const reads: AbortSignal[] = [];
    const handle = await launchGateway({
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      exec: fakeExec,
      clock,
      timers,
      pid: 424_242,
      role,
      runtimeHealth: (signal) =>
        new Promise((_resolve, reject) => {
          reads.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
      requestShutdown: () => undefined,
    });

    expect(handle.ready.pid).toBe(424_242);
    expect((await getJson(clientFor(handle.socketPath), '/v1/momonga/health')).body.pid).toBe(424_242);

    role.become('retiring');
    timers.advance(SWEEP_INTERVAL_MS);
    await until(() => reads.length === 1, 'the runtime health read to start');
    expect(reads[0]?.aborted).toBe(false);
    expect(timers.pending().some((timer) => timer.delayMs === CONTROL_REQUEST_TIMEOUT_MS)).toBe(true);

    timers.advance(CONTROL_REQUEST_TIMEOUT_MS);

    expect(reads[0]?.aborted).toBe(true);
    expect((reads[0]?.reason as DOMException).name).toBe('TimeoutError');
  });
});
