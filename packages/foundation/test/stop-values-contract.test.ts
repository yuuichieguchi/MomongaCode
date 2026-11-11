import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STOP_VALUES,
  MAXIMUM_STOP_VALUES,
  SHUTDOWN_SETTING_LIMITS,
  STOP_MESSAGE_MAX_BYTES,
  STOP_VALUE_NAMES,
  STOP_WAIT_WHEN_UNKNOWN_MS,
  daemonStopBoundMs,
  formatStopMessage,
  gatewayAbortBudgetMs,
  gatewayAbortCloseMs,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  managedServerReapBoundMs,
  markerReapClockBoundMs,
  mcpPoolCloseBoundMs,
  parseStopMessage,
  parseStopValues,
  runtimeMaxCloseMs,
  runtimeStopBudgetMs,
  runtimeTeardownBudgetMs,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';

const ZERO: StopValues = { closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 0, mcpCloseGraceMs: 0 };
const MAXIMA: StopValues = { closeGraceMs: 300_000, managedServerStopGraceMs: 60_000, drainTimeoutMs: 300_000, mcpCloseGraceMs: 30_000 };
const ZERO_RUNTIME: StopValues = { closeGraceMs: 10_000, managedServerStopGraceMs: 3000, drainTimeoutMs: 0, mcpCloseGraceMs: 0 };

describe('the four stop values and their limits', () => {
  it('pins the limits and defaults of all four settings', () => {
    expect(SHUTDOWN_SETTING_LIMITS).toEqual({
      closeGraceMs: { min: 0, max: 300_000, default: 10_000 },
      managedServerStopGraceMs: { min: 0, max: 60_000, default: 3000 },
      drainTimeoutMs: { min: 0, max: 300_000, default: 30_000 },
      mcpCloseGraceMs: { min: 0, max: 30_000, default: 1000 },
    });
    expect([...STOP_VALUE_NAMES].sort()).toEqual(['closeGraceMs', 'drainTimeoutMs', 'managedServerStopGraceMs', 'mcpCloseGraceMs']);
    expect(DEFAULT_STOP_VALUES).toEqual({ closeGraceMs: 10_000, managedServerStopGraceMs: 3000, drainTimeoutMs: 30_000, mcpCloseGraceMs: 1000 });
    expect(MAXIMUM_STOP_VALUES).toEqual(MAXIMA);
  });

  it('parses the four values and names the first one out of range', () => {
    expect(parseStopValues({ closeGraceMs: 1, managedServerStopGraceMs: 2, drainTimeoutMs: 3, mcpCloseGraceMs: 4 })).toEqual({
      kind: 'values',
      values: { closeGraceMs: 1, managedServerStopGraceMs: 2, drainTimeoutMs: 3, mcpCloseGraceMs: 4 },
    });
    expect(parseStopValues({ closeGraceMs: 1, managedServerStopGraceMs: 2, drainTimeoutMs: 300_001, mcpCloseGraceMs: 4 })).toEqual({
      kind: 'invalid',
      reason: 'drainTimeoutMs must be an integer from 0 to 300000 milliseconds; got 300001',
    });
    expect(parseStopValues({ closeGraceMs: 1, managedServerStopGraceMs: 2, drainTimeoutMs: 3, mcpCloseGraceMs: 30_001 })).toEqual({
      kind: 'invalid',
      reason: 'mcpCloseGraceMs must be an integer from 0 to 30000 milliseconds; got 30001',
    });
  });
});

describe('the derived MCP and runtime bounds (K = KILL_CONFIRM_MS = 5000, RUNTIME_ABORT_BUDGET_MS = 8050)', () => {
  it.each([
    [0, 10_075, 20_075],
    [1, 10_081, 20_081],
    [1000, 16_075, 26_075],
    [30_000, 190_075, 200_075],
  ])('one pool close at grace %d is 6g + 75 + 2K = %d, and the teardown budget is 10000 plus it = %d', (grace, poolClose, teardown) => {
    expect(mcpPoolCloseBoundMs(grace)).toBe(poolClose);
    expect(runtimeTeardownBudgetMs(grace)).toBe(teardown);
  });

  it('gives 64125 and 69125 at the defaults', () => {
    expect(runtimeMaxCloseMs(DEFAULT_STOP_VALUES)).toBe(64_125);
    expect(runtimeStopBudgetMs(DEFAULT_STOP_VALUES)).toBe(69_125);
  });

  it('gives 508125 at the maxima', () => {
    expect(runtimeMaxCloseMs(MAXIMA)).toBe(508_125);
  });

  it('takes the drain and the MCP grace from the values, and neither gateway value', () => {
    const runtime = { drainTimeoutMs: 7, mcpCloseGraceMs: 3 };
    expect(runtimeMaxCloseMs({ closeGraceMs: 0, managedServerStopGraceMs: 0, ...runtime })).toBe(7 + 8050 + 10_000 + 18 + 10_075);
    expect(runtimeMaxCloseMs({ closeGraceMs: 300_000, managedServerStopGraceMs: 60_000, ...runtime })).toBe(7 + 8050 + 10_000 + 18 + 10_075);
  });

  it('gives 20075 teardown, 28125 runtime close and 33125 runtime stop at drain 0 and grace 0', () => {
    expect(runtimeTeardownBudgetMs(0)).toBe(20_075);
    expect(runtimeMaxCloseMs(ZERO_RUNTIME)).toBe(28_125);
    expect(runtimeStopBudgetMs(ZERO_RUNTIME)).toBe(33_125);
  });
});

describe('one formula over the values of a stop', () => {
  it('gives 32075, 37075, 143275 and 146275 at the defaults', () => {
    expect(gatewayMaxCloseMs(DEFAULT_STOP_VALUES)).toBe(32_075);
    expect(gatewayStopBudgetMs(DEFAULT_STOP_VALUES)).toBe(37_075);
    expect(supervisorMaxCloseMs(DEFAULT_STOP_VALUES)).toBe(143_275);
    expect(daemonStopBoundMs(DEFAULT_STOP_VALUES)).toBe(146_275);
  });

  it('gives 107275 and 110275 at drain 0 and MCP grace 0 with the default gateway values', () => {
    expect(supervisorMaxCloseMs(ZERO_RUNTIME)).toBe(107_275);
    expect(daemonStopBoundMs(ZERO_RUNTIME)).toBe(110_275);
  });

  it('gives 1276275 and 1279275 at the allowed maxima, and the unknown-values stop wait is the latter', () => {
    expect(gatewayMaxCloseMs(MAXIMA)).toBe(550_075);
    expect(supervisorMaxCloseMs(MAXIMA)).toBe(1_276_275);
    expect(daemonStopBoundMs(MAXIMA)).toBe(1_279_275);
    expect(STOP_WAIT_WHEN_UNKNOWN_MS).toBe(1_279_275);
  });

  it('gives 76275 and 79275 at all-zero values', () => {
    expect(gatewayMaxCloseMs(ZERO)).toBe(10_075);
    expect(gatewayStopBudgetMs(ZERO)).toBe(15_075);
    expect(supervisorMaxCloseMs(ZERO)).toBe(76_275);
    expect(daemonStopBoundMs(ZERO)).toBe(79_275);
  });

  it('bounds the managed-server reap by the bound of the marker reaper it calls: three windows of the grace plus K', () => {
    expect(managedServerReapBoundMs(DEFAULT_STOP_VALUES)).toBe(14_075);
    expect(managedServerReapBoundMs({ ...ZERO, closeGraceMs: 999, managedServerStopGraceMs: 250 })).toBe(5825);
    expect(managedServerReapBoundMs(ZERO)).toBe(5075);
    for (const grace of [0, 1, 250, 3000, 60_000]) {
      expect(managedServerReapBoundMs({ ...ZERO, managedServerStopGraceMs: grace }), String(grace)).toBe(markerReapClockBoundMs(grace));
    }
  });

  it('bounds an aborting gateway by its managed-server stop alone, 4m + 75 + 2K, plus the margin for the supervisor budget', () => {
    expect(gatewayAbortCloseMs(DEFAULT_STOP_VALUES)).toBe(22_075);
    expect(gatewayAbortBudgetMs(DEFAULT_STOP_VALUES)).toBe(27_075);
    expect(gatewayAbortCloseMs({ ...ZERO, closeGraceMs: 300_000, managedServerStopGraceMs: 500 })).toBe(12_075);
    expect(gatewayAbortBudgetMs(ZERO)).toBe(15_075);
  });

  it.each([
    [{ closeGraceMs: 1, managedServerStopGraceMs: 0, drainTimeoutMs: 0, mcpCloseGraceMs: 0 }, 76_276],
    [{ closeGraceMs: 0, managedServerStopGraceMs: 1, drainTimeoutMs: 0, mcpCloseGraceMs: 0 }, 76_282],
    [{ closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 1, mcpCloseGraceMs: 0 }, 76_276],
    [{ closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 0, mcpCloseGraceMs: 1 }, 76_281],
    [{ closeGraceMs: 2000, managedServerStopGraceMs: 500, drainTimeoutMs: 30_000, mcpCloseGraceMs: 250 }, 113_275],
  ])('supervisor close with %o is %d (drain + close grace + 7 x stop grace + 6 x MCP grace + 76275)', (values, expected) => {
    expect(supervisorMaxCloseMs(values)).toBe(expected);
  });

  it('the daemon stop bound is the supervisor close of the same values plus the hard-exit margin', () => {
    const values = { closeGraceMs: 2000, managedServerStopGraceMs: 500, drainTimeoutMs: 1234, mcpCloseGraceMs: 7 };
    expect(daemonStopBoundMs(values)).toBe(supervisorMaxCloseMs(values) + 3000);
    expect(daemonStopBoundMs(values)).toBe(1234 + 2000 + 3500 + 42 + 76_275 + 3000);
  });
});

describe('the lifeline stop message', () => {
  it('formats one line with the event and the four values', () => {
    expect(formatStopMessage({ closeGraceMs: 1234, managedServerStopGraceMs: 56, drainTimeoutMs: 7890, mcpCloseGraceMs: 12 })).toBe(
      '{"event":"stop","closeGraceMs":1234,"managedServerStopGraceMs":56,"drainTimeoutMs":7890,"mcpCloseGraceMs":12}\n',
    );
  });

  it('parses a valid line, with or without its newline', () => {
    expect(parseStopMessage('{"event":"stop","closeGraceMs":0,"managedServerStopGraceMs":60000,"drainTimeoutMs":300000,"mcpCloseGraceMs":30000}')).toEqual({
      kind: 'stop',
      values: { closeGraceMs: 0, managedServerStopGraceMs: 60_000, drainTimeoutMs: 300_000, mcpCloseGraceMs: 30_000 },
    });
    expect(parseStopMessage(formatStopMessage(MAXIMA))).toEqual({ kind: 'stop', values: MAXIMA });
    expect(parseStopMessage(formatStopMessage(ZERO))).toEqual({ kind: 'stop', values: ZERO });
  });

  it.each([
    ['not JSON', 'stop'],
    ['an array', '[]'],
    ['another event', '{"event":"ready","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":1,"mcpCloseGraceMs":1}'],
    ['the two-value line of revision 6', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1}'],
    ['a missing drain', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"mcpCloseGraceMs":1}'],
    ['a missing MCP grace', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":1}'],
    ['a fraction', '{"event":"stop","closeGraceMs":1.5,"managedServerStopGraceMs":1,"drainTimeoutMs":1,"mcpCloseGraceMs":1}'],
    ['a negative drain', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":-1,"mcpCloseGraceMs":1}'],
    ['a drain over the maximum', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":300001,"mcpCloseGraceMs":1}'],
    ['an MCP grace over the maximum', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":1,"mcpCloseGraceMs":30001}'],
    ['a string MCP grace', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":1,"mcpCloseGraceMs":"1"}'],
    ['a fractional drain', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":0.5,"mcpCloseGraceMs":1}'],
    ['a close grace over the maximum', '{"event":"stop","closeGraceMs":300001,"managedServerStopGraceMs":1,"drainTimeoutMs":1,"mcpCloseGraceMs":1}'],
    ['a field beyond the five', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":1,"mcpCloseGraceMs":1,"extra":true}'],
  ])('refuses %s as malformed with a reason', (_label, line) => {
    const parsed = parseStopMessage(line);
    expect(parsed.kind).toBe('malformed');
    expect(parsed.kind === 'malformed' ? parsed.reason.length : 0).toBeGreaterThan(0);
  });

  it('keeps the largest valid line within 256 bytes and refuses a longer one', () => {
    expect(STOP_MESSAGE_MAX_BYTES).toBe(256);
    expect(Buffer.byteLength(formatStopMessage(MAXIMA), 'utf8')).toBeLessThanOrEqual(STOP_MESSAGE_MAX_BYTES);
    const padded = `{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"drainTimeoutMs":1,"mcpCloseGraceMs":1,"pad":"${'x'.repeat(256)}"}`;
    expect(parseStopMessage(padded)).toEqual({ kind: 'malformed', reason: 'the line is longer than 256 bytes' });
  });
});
