import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STOP_VALUES,
  ENTRY_HARD_EXIT_MARGIN_MS,
  GATEWAY_MAX_CLOSE_MS,
  SHUTDOWN_SETTING_LIMITS,
  STOP_MESSAGE_MAX_BYTES,
  daemonStopBoundMs,
  formatStopMessage,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  parseStopMessage,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';

const ZERO: StopValues = { closeGraceMs: 0, managedServerStopGraceMs: 0 };
const MAXIMA: StopValues = { closeGraceMs: 300_000, managedServerStopGraceMs: 60_000 };

describe('the stop values and their limits', () => {
  it('pins the limits and defaults of both settings', () => {
    expect(SHUTDOWN_SETTING_LIMITS).toEqual({
      closeGraceMs: { min: 0, max: 300_000, default: 10_000 },
      managedServerStopGraceMs: { min: 0, max: 60_000, default: 3000 },
    });
    expect(DEFAULT_STOP_VALUES).toEqual({ closeGraceMs: 10_000, managedServerStopGraceMs: 3000 });
  });
});

describe('one formula over the values of a stop', () => {
  it('gives 28000, 33000, 76000 and 109000 at the defaults', () => {
    expect(gatewayMaxCloseMs(DEFAULT_STOP_VALUES)).toBe(28_000);
    expect(gatewayStopBudgetMs(DEFAULT_STOP_VALUES)).toBe(33_000);
    expect(supervisorMaxCloseMs(0, DEFAULT_STOP_VALUES)).toBe(76_000);
    expect(supervisorMaxCloseMs(30_000, DEFAULT_STOP_VALUES)).toBe(106_000);
    expect(daemonStopBoundMs(DEFAULT_STOP_VALUES)).toBe(109_000);
    expect(GATEWAY_MAX_CLOSE_MS).toBe(gatewayMaxCloseMs(DEFAULT_STOP_VALUES));
  });

  it('gives 0, 5000, 48000 and 81000 at zero values', () => {
    expect(gatewayMaxCloseMs(ZERO)).toBe(0);
    expect(gatewayStopBudgetMs(ZERO)).toBe(5000);
    expect(supervisorMaxCloseMs(0, ZERO)).toBe(48_000);
    expect(daemonStopBoundMs(ZERO)).toBe(81_000);
  });

  it('gives 660000 and 741000 at the allowed maxima', () => {
    expect(gatewayMaxCloseMs(MAXIMA)).toBe(660_000);
    expect(daemonStopBoundMs(MAXIMA)).toBe(741_000);
  });

  it.each([
    [0, { closeGraceMs: 1, managedServerStopGraceMs: 0 }, 48_001],
    [0, { closeGraceMs: 0, managedServerStopGraceMs: 1 }, 48_006],
    [7, { closeGraceMs: 100, managedServerStopGraceMs: 10 }, 48_167],
    [30_000, { closeGraceMs: 2000, managedServerStopGraceMs: 500 }, 83_000],
  ])('supervisor close at drain %d with %o is %d (drain + close grace + 6 x stop grace + 48000)', (drain, values, expected) => {
    expect(supervisorMaxCloseMs(drain, values)).toBe(expected);
  });

  it('the daemon stop bound is the supervisor close at the default drain plus the hard-exit margin', () => {
    const values = { closeGraceMs: 2000, managedServerStopGraceMs: 500 };
    expect(daemonStopBoundMs(values)).toBe(83_000 + ENTRY_HARD_EXIT_MARGIN_MS);
  });
});

describe('the lifeline stop message', () => {
  it('formats one line', () => {
    expect(formatStopMessage({ closeGraceMs: 1234, managedServerStopGraceMs: 56 })).toBe('{"event":"stop","closeGraceMs":1234,"managedServerStopGraceMs":56}\n');
  });

  it('parses a valid line, with or without its newline', () => {
    expect(parseStopMessage('{"event":"stop","closeGraceMs":0,"managedServerStopGraceMs":60000}')).toEqual({ kind: 'stop', values: { closeGraceMs: 0, managedServerStopGraceMs: 60_000 } });
    expect(parseStopMessage(formatStopMessage(MAXIMA))).toEqual({ kind: 'stop', values: MAXIMA });
  });

  it.each([
    ['not JSON', 'stop'],
    ['an array', '[]'],
    ['another event', '{"event":"ready","closeGraceMs":1,"managedServerStopGraceMs":1}'],
    ['a missing field', '{"event":"stop","closeGraceMs":1}'],
    ['a fraction', '{"event":"stop","closeGraceMs":1.5,"managedServerStopGraceMs":1}'],
    ['a negative value', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":-1}'],
    ['a close grace over the maximum', '{"event":"stop","closeGraceMs":300001,"managedServerStopGraceMs":1}'],
    ['a stop grace over the maximum', '{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":60001}'],
    ['a string number', '{"event":"stop","closeGraceMs":"1","managedServerStopGraceMs":1}'],
  ])('refuses %s as malformed with a reason', (_label, line) => {
    const parsed = parseStopMessage(line);
    expect(parsed.kind).toBe('malformed');
    expect(parsed.kind === 'malformed' ? parsed.reason.length : 0).toBeGreaterThan(0);
  });

  it('refuses a line longer than 256 bytes', () => {
    expect(STOP_MESSAGE_MAX_BYTES).toBe(256);
    const padded = `{"event":"stop","closeGraceMs":1,"managedServerStopGraceMs":1,"pad":"${'x'.repeat(256)}"}`;
    expect(parseStopMessage(padded).kind).toBe('malformed');
  });
});
