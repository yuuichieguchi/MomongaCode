import { describe, expect, it } from 'vitest';
import { agentReadiness, isNotListedCapabilities, isToolCallingState, isUnavailableCapabilities, notListedMessage } from '../src/index.ts';
import type { NotListedCapabilities, ToolCallingState } from '../src/index.ts';

const UNAVAILABLE = { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: 'm', param: 'model' } as const;
const PROBING = { toolCalling: { state: 'probing', message: 'probing local', retryAfterSeconds: 5 }, source: 'unprobed' } as const;
const UNAVAILABLE_CAPABILITIES = { toolCalling: UNAVAILABLE, source: 'unprobed' } as const;
const READY = { toolCalling: 'native' } as const;

describe('the unavailable state of a models listing entry', () => {
  it('isToolCallingState accepts an unavailable state and refuses a malformed one', () => {
    const { code: _code, ...withoutCode } = UNAVAILABLE;
    expect(isToolCallingState(UNAVAILABLE)).toBe(true);
    expect([{ ...UNAVAILABLE, status: 'x' }, { ...UNAVAILABLE, status: 99 }, { ...UNAVAILABLE, type: 'bogus' }, withoutCode, { ...UNAVAILABLE, param: 1 }].map((value) => isToolCallingState(value))).toEqual([false, false, false, false, false]);
  });

  it('agentReadiness maps an unavailable state to the unavailable readiness', () => {
    expect(agentReadiness({ toolCalling: UNAVAILABLE as unknown as ToolCallingState })).toEqual({ state: 'unavailable', message: 'm' });
  });

  it('isUnavailableCapabilities, isNotListedCapabilities and notListedMessage', () => {
    const samples = [PROBING, UNAVAILABLE_CAPABILITIES, READY] as unknown as { toolCalling: ToolCallingState }[];
    expect(samples.map((sample) => isUnavailableCapabilities(sample))).toEqual([false, true, false]);
    expect(samples.map((sample) => isNotListedCapabilities(sample))).toEqual([true, true, false]);
    expect(notListedMessage(PROBING as unknown as NotListedCapabilities)).toBe('probing local');
    expect(notListedMessage(UNAVAILABLE_CAPABILITIES as unknown as NotListedCapabilities)).toBe('m');
  });
});
