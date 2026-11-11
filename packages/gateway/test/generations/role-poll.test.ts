import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, GENERATION_ROLE_UNREADABLE_EVENT, SWEEP_INTERVAL_MS, createJsonLogger, generationLayout, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, testKernelLock } from '@momonga/testkit';
import { getJson } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, until, writeSettings } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SECOND_GENERATION = 2;

const launch = async () => {
  const home = makeHome();
  writeSettings(home, {});
  const clock = createFakeClock(Date.now());
  const timers = createFakeTimers(clock);
  const logLines: string[] = [];
  const logger = createJsonLogger({ service: 'gateway', clock, stream: { write: (line: string) => logLines.push(line) > 0 } });
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, clock, timers, logger, runtimeHealth: async () => 'busy' });
  const client = clientFor(handle.socketPath);
  const paths = momongaPaths(home, process.platform, {});
  const pollArmed = (): boolean => timers.pending().some((timer) => timer.delayMs === SWEEP_INTERVAL_MS);
  const publish = async (generation: number): Promise<void> => {
    expect(await publishCurrentGeneration(paths, { generation, version: PROCESS_VERSION, sockets: generationLayout(home, generation).sockets }, { lock: testKernelLock() })).toBe('published');
  };
  const poll = async (): Promise<void> => {
    timers.advance(SWEEP_INTERVAL_MS);
    await until(pollArmed, 'the poll to finish and arm the next one');
  };
  const stateNow = async (): Promise<string> => (await getJson(client, '/v1/momonga/health')).body.state;
  return { handle, timers, paths, logLines, pollArmed, publish, poll, stateNow };
};

describe('the gateway reads its role from run/current at a one-second tick (design-update 18.1, 20.2)', () => {
  it('takes the tick from the one constant of foundation, 1000 ms, and arms it again after each poll', async () => {
    const gateway = await launch();

    expect(SWEEP_INTERVAL_MS).toBe(1000);
    expect(gateway.pollArmed()).toBe(true);
    await gateway.poll();
    await gateway.poll();
    expect(gateway.timers.pending().filter((timer) => timer.delayMs === SWEEP_INTERVAL_MS)).toHaveLength(1);
  });

  it('is starting with no record, serving once the record names it, and retiring at the tick after the record names a newer generation, not before', async () => {
    const gateway = await launch();
    expect(gateway.handle.role()).toBe('starting');
    expect(await gateway.stateNow()).toBe('running');

    await gateway.publish(FIRST_GENERATION);
    await gateway.poll();
    expect(gateway.handle.role()).toBe('serving');

    await gateway.publish(SECOND_GENERATION);
    gateway.timers.advance(SWEEP_INTERVAL_MS - 1);
    expect(gateway.handle.role()).toBe('serving');
    expect(await gateway.stateNow()).toBe('running');

    gateway.timers.advance(1);
    await until(() => gateway.handle.role() === 'retiring', 'the gateway to learn that it is retiring');
    expect(await gateway.stateNow()).toBe('retiring');
  });

  it('keeps its role when the record cannot be read, and logs that once', async () => {
    const gateway = await launch();
    await gateway.publish(FIRST_GENERATION);
    await gateway.poll();

    fs.writeFileSync(gateway.paths.current, 'not a record');
    await gateway.poll();
    await gateway.poll();

    expect(gateway.handle.role()).toBe('serving');
    expect(gateway.logLines.filter((line) => line.includes(GENERATION_ROLE_UNREADABLE_EVENT))).toHaveLength(1);
  });
});
