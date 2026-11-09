import { describe, expect, it } from 'vitest';
import { KILL_CONFIRM_MS, formatStopMessage } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { createManagerHarness } from './support/p2-manager-harness.ts';

const VALUES: StopValues = { closeGraceMs: 1200, managedServerStopGraceMs: 300 };
const GATEWAY_STOP_BUDGET_AT_VALUES_MS = 1200 + 6 * 300 + 5000;

describe('the gateway stop carries its values on the lifeline', () => {
  it('writes one stop line with the values before SIGTERM', async (context) => {
    const harness = createManagerHarness(context, { role: 'gateway' });
    harness.spawnInitial();
    const written: string[] = [];
    const child = harness.port.last();
    const write = child.lifeline.write.bind(child.lifeline);
    child.lifeline.write = ((chunk: string, ...rest: never[]) => {
      written.push(String(chunk));
      return write(chunk, ...rest);
    }) as typeof child.lifeline.write;
    const signalsAtWrite: number[] = [];
    harness.port.onSignal = () => signalsAtWrite.push(written.length);
    void harness.manager.stop('shutdown', 'term', VALUES);
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toEqual([formatStopMessage(VALUES)]);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(signalsAtWrite).toEqual([1]);
  });

  it('bounds the gateway stop by the values of that stop (close grace + 6 x stop grace + margin)', async (context) => {
    const harness = createManagerHarness(context, { role: 'gateway' });
    harness.spawnInitial();
    void harness.manager.stop('shutdown', 'term', VALUES);
    await new Promise((resolve) => setImmediate(resolve));
    harness.timers.advance(GATEWAY_STOP_BUDGET_AT_VALUES_MS - 1);
    expect(harness.port.last().groupKills).toBe(0);
    harness.timers.advance(1);
    expect(harness.port.last().groupKills).toBe(1);
  });

  it('a lifeline that cannot be written takes the forced path: no graceful signal, a group kill, confirmed within KILL_CONFIRM_MS', async (context) => {
    const harness = createManagerHarness(context, { role: 'gateway' });
    harness.spawnInitial();
    const child = harness.port.last();
    child.lifeline.destroy();
    const stopped = harness.manager.stop('shutdown', 'term', VALUES);
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.signals).toEqual([]);
    expect(child.groupKills).toBe(1);
    harness.timers.advance(KILL_CONFIRM_MS - 1);
    expect(harness.manager.state()).toBe('stopping');
    harness.timers.advance(1);
    await expect(stopped).resolves.toEqual({ killed: true, leaked: true });
  });
});
