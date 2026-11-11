import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EXIT_RETIRED, FIRST_GENERATION, SWEEP_INTERVAL_MS, inspectProcessLock } from '@momonga/foundation';
import type { RuntimeStanding } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, fakeExec, testKernelLock } from '@momonga/testkit';
import { getJson, makeDir, postJson, readJson, registerCleanup, switchableRole, userInput } from '../gateway-helpers.ts';
import { IDENTITY_READ_TIMEOUT_MS } from '../../src/probe/endpoint-target.ts';
import { CC_MODEL, PROCESS_VERSION, baseEnv, ccTarget, clientFor, homePaths, launchGateway, makeHome, until, writeSettings, modelsOf } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const ASK = { model: `local/${CC_MODEL}`, input: userInput('hi') };

const holdingUpstream = async () => {
  const socketPath = path.join(makeDir(), 'up.sock');
  const held: http.ServerResponse[] = [];
  const server = http.createServer((_request, response) => {
    held.push(response);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(() => {
    server.closeAllConnections();
    server.close();
  });
  const refuse = (): void => {
    for (const response of held.splice(0)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'the fake upstream refuses the held call' } }));
    }
  };
  return { socketPath, held, refuse };
};

const launch = async (target: Record<string, unknown>, extra: Partial<GatewayProcessOptions> = {}, wired: { requestShutdown: boolean } = { requestShutdown: true }) => {
  const home = makeHome();
  writeSettings(home, { models: modelsOf({ local: target }) });
  const clock = createFakeClock(Date.now());
  const timers = createFakeTimers(clock);
  const role = switchableRole('serving');
  const runtime: { standing: RuntimeStanding; dials: number } = { standing: 'gone', dials: 0 };
  const shutdowns = { requested: 0 };
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    exec: fakeExec,
    clock,
    timers,
    role,
    runtimeHealth: async () => {
      runtime.dials += 1;
      return runtime.standing;
    },
    ...(wired.requestShutdown ? { requestShutdown: () => void (shutdowns.requested += 1) } : {}),
    ...extra,
  });
  const client = clientFor(handle.socketPath);
  const tick = async (): Promise<void> => {
    timers.advance(SWEEP_INTERVAL_MS);
    await until(() => timers.pending().some((timer) => timer.delayMs === SWEEP_INTERVAL_MS), 'the tick to finish and arm the next one');
  };
  const active = async (): Promise<number> => (await getJson(client, '/v1/momonga/health')).body.activeRequests;
  return { home, handle, client, role, runtime, shutdowns, tick, active, timers };
};

describe('a retiring gateway leaves only when it holds nothing and its runtime is gone or idle (design-update 18.1, 20.1, 20.52)', () => {
  it('never asks to leave while its role is serving, and dials no runtime', async () => {
    const upstream = await holdingUpstream();
    const gateway = await launch(ccTarget(upstream.socketPath, { toolCalling: 'native' }));

    await gateway.tick();
    await gateway.tick();

    expect(gateway.shutdowns.requested).toBe(0);
    expect(gateway.runtime.dials).toBe(0);
  });

  it('waits while its runtime answers anything but retiring with no step, leaves once the runtime is idle, and its close reports exit code 79', async () => {
    const upstream = await holdingUpstream();
    const gateway = await launch(ccTarget(upstream.socketPath, { toolCalling: 'native' }));
    gateway.role.become('retiring');
    gateway.runtime.standing = 'busy';

    await gateway.tick();
    await gateway.tick();
    expect(gateway.shutdowns.requested).toBe(0);
    expect(gateway.runtime.dials).toBe(2);

    gateway.runtime.standing = 'idle';
    await gateway.tick();
    expect(gateway.shutdowns.requested).toBe(1);

    const closed = await gateway.handle.close();
    expect(closed).toMatchObject({ clean: true, exitCode: EXIT_RETIRED });
    expect(fs.existsSync(gateway.handle.socketPath)).toBe(false);
    expect((await inspectProcessLock(homePaths(gateway.home).lock, { mechanism: testKernelLock() })).state).toBe('free');
  });

  it('does not leave while an accepted call is open, even with its runtime gone, and leaves after the call ended', async () => {
    const upstream = await holdingUpstream();
    const gateway = await launch(ccTarget(upstream.socketPath, { toolCalling: 'native' }));
    const answering = postJson(gateway.client, '/v1/responses', ASK);
    await until(() => upstream.held.length === 1, 'the call to reach its upstream');
    gateway.role.become('retiring');

    await gateway.tick();
    await gateway.tick();
    expect(gateway.shutdowns.requested).toBe(0);
    expect(gateway.runtime.dials).toBe(0);
    expect(await gateway.active()).toBe(1);

    const refused = await readJson(await postJson(clientFor(gateway.handle.socketPath), '/v1/responses', ASK));
    expect([refused.status, refused.body.error.code]).toEqual([503, 'generation_retired']);
    expect(upstream.held).toHaveLength(1);

    const heldBeforeRefusal = upstream.held.length;
    upstream.refuse();
    expect((await readJson(await answering)).status).toBeGreaterThanOrEqual(400);
    expect(heldBeforeRefusal).toBe(1);
    await until(async () => (await gateway.active()) === 0, 'the call to end');
    await gateway.tick();
    expect(gateway.shutdowns.requested).toBe(1);
  });

  it('does not leave while a probe flight is open, and leaves after the flight ended', async () => {
    const upstream = await holdingUpstream();
    const flight = Promise.withResolvers<never>();
    const gateway = await launch(ccTarget(upstream.socketPath, { toolCalling: 'auto' }), { measureEndpoint: () => flight.promise });
    const asked = postJson(gateway.client, '/v1/responses', ASK);
    await until(() => gateway.timers.pending().some((timer) => timer.delayMs === IDENTITY_READ_TIMEOUT_MS), 'the precondition bound to be armed on the timer port');
    await gateway.timers.advanceAsync(IDENTITY_READ_TIMEOUT_MS);
    expect((await readJson(await asked)).status).toBe(503);
    expect(await gateway.active()).toBe(1);
    gateway.role.become('retiring');

    await gateway.tick();
    expect(gateway.shutdowns.requested).toBe(0);

    flight.reject(new Error('the measurement ended'));
    await until(async () => (await gateway.active()) === 0, 'the flight to end');
    await gateway.tick();
    expect(gateway.shutdowns.requested).toBe(1);
  });

  it('closes itself when no entry is wired, with exit code 79', async () => {
    const upstream = await holdingUpstream();
    const gateway = await launch(ccTarget(upstream.socketPath, { toolCalling: 'native' }), {}, { requestShutdown: false });
    gateway.role.become('retiring');

    await gateway.tick().catch(() => undefined);
    await until(async () => (await inspectProcessLock(homePaths(gateway.home).lock, { mechanism: testKernelLock() })).state === 'free', 'the gateway to release its lock');

    expect(await gateway.handle.close()).toMatchObject({ clean: true, exitCode: EXIT_RETIRED });
  });

  it('reports no retire exit code for the user stop of a retiring gateway', async () => {
    const upstream = await holdingUpstream();
    const gateway = await launch(ccTarget(upstream.socketPath, { toolCalling: 'native' }));
    gateway.role.become('retiring');
    gateway.runtime.standing = 'busy';
    await gateway.tick();

    const closed = await gateway.handle.close();

    expect(closed.clean).toBe(true);
    expect(closed.exitCode).toBeUndefined();
  });
});
