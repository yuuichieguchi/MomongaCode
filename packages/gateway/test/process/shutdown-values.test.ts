import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, fakeExec } from '@momonga/testkit';
import { makeDir, postJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { CC_MODEL, PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, modelsOf, until, writeSettings } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CLOSE_GRACE_MS = 4_321;
const ABORT_GRACE_MS = 9_876;

const valuesWithGrace = (closeGraceMs: number): StopValues => ({ closeGraceMs, managedServerStopGraceMs: 0, drainTimeoutMs: 300_000, mcpCloseGraceMs: 30_000 });

const gatewayWithHeldCall = async () => {
  const socketPath = path.join(makeDir(), 'up.sock');
  const held: http.ServerResponse[] = [];
  const upstream = http.createServer((_request, response) => void held.push(response));
  await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
  registerCleanup(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const home = makeHome();
  writeSettings(home, { models: modelsOf({ local: ccTarget(socketPath, { toolCalling: 'native' }) }) });
  const clock = createFakeClock(Date.now());
  const timers = createFakeTimers(clock);
  const delays: number[] = [];
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    exec: fakeExec,
    clock,
    timers: { ...timers, setTimeout: (callback, ms) => (delays.push(ms), timers.setTimeout(callback, ms)) },
  });
  const answering = postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${CC_MODEL}`, input: userInput('hi') }, { 'idempotency-key': 'held-through-the-close' });
  answering.catch(() => undefined);
  await until(() => held.length === 1, 'the call to reach its upstream');
  return { handle, timers, delays };
};

describe('a shutdown passes its values to every part it closes (gateway-core-C33)', () => {
  it('an abort asked in the tick of the close cuts the wait of the close values and brings none of its own', async () => {
    const { handle, delays } = await gatewayWithHeldCall();

    const closing = handle.close(valuesWithGrace(CLOSE_GRACE_MS));
    const aborting = handle.abort(valuesWithGrace(ABORT_GRACE_MS));
    const [closed, aborted] = await Promise.all([closing, aborting]);

    expect(aborted).toBe(closed);
    expect(closed.abandonedRuns).toBe(1);
    expect(delays).toContain(CLOSE_GRACE_MS);
    expect(delays).not.toContain(ABORT_GRACE_MS);
  });

  it('an abort asked while the close waits under its grace cuts that wait', async () => {
    const { handle, timers, delays } = await gatewayWithHeldCall();

    const closing = handle.close(valuesWithGrace(CLOSE_GRACE_MS));
    await until(() => timers.pending().some((timer) => timer.delayMs === CLOSE_GRACE_MS), 'the close to wait under its grace');
    const closed = await handle.abort(valuesWithGrace(ABORT_GRACE_MS));

    expect(await closing).toBe(closed);
    expect(closed.abandonedRuns).toBe(1);
    expect(delays).not.toContain(ABORT_GRACE_MS);
    expect(timers.pending().some((timer) => timer.delayMs === CLOSE_GRACE_MS)).toBe(false);
  });
});
