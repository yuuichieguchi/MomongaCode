import { describe, expect, it } from 'vitest';
import { TARGET_NOT_READY, agentReadiness } from '../src/index.ts';
import type { NeedsProbe } from '../src/index.ts';

const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'target local has not been probed for tool calling',
  evidence: 'no probe record for local',
  remedy: 'run /model probe local',
};

describe('agentReadiness decides whether a target can run a task from its reported capabilities alone', () => {
  it.each(['native', 'constrained'] as const)('a target that calls tools %s is ready', (toolCalling) => {
    expect(agentReadiness({ toolCalling })).toEqual({ state: 'ready' });
  });

  it('a target that reports no tool calling runs without tools and carries the message alone', () => {
    const readiness = agentReadiness({ toolCalling: 'none' });
    expect(readiness.state).toBe('no_tools');
    if (readiness.state !== 'no_tools') return;
    expect(readiness.message).toMatch(/cannot call tools/);
    expect(readiness).not.toHaveProperty('remedy');
  });

  it('an unprobed target is never guessed: it carries the message, evidence and remedy the gateway reported', () => {
    expect(agentReadiness({ toolCalling: NEEDS_PROBE })).toEqual({
      state: 'needs_probe',
      message: NEEDS_PROBE.message,
      evidence: NEEDS_PROBE.evidence,
      remedy: NEEDS_PROBE.remedy,
    });
  });

  it('a target the gateway could not reach is unavailable and carries the gateway reason', () => {
    const reason = 'the chat-completions upstream at http://127.0.0.1:1 refused the connection';
    const readiness = agentReadiness({ unavailable: reason });
    expect(readiness.state).toBe('unavailable');
    if (readiness.state !== 'unavailable') return;
    expect(readiness.message).toBe(reason);
    expect(readiness).not.toHaveProperty('remedy');
  });

  it('reads no target name: two capability sets that differ only outside toolCalling give the same verdict', () => {
    const base = { contextWindow: 8192, maxOutputTokens: 1024, toolCalling: 'none' as const };
    expect(agentReadiness({ ...base, contextWindow: 1 })).toEqual(agentReadiness(base));
  });

  it('names the run error code target_not_ready', () => {
    expect(TARGET_NOT_READY).toBe('target_not_ready');
  });

  it('only the verdict of an unprobed target carries a remedy: it is the data of the probe', () => {
    const verdicts = [agentReadiness({ toolCalling: 'none' }), agentReadiness({ toolCalling: NEEDS_PROBE }), agentReadiness({ unavailable: 'down' })];
    expect(verdicts.map((verdict) => verdict.state)).toEqual(['no_tools', 'needs_probe', 'unavailable']);
    expect(verdicts.map((verdict) => ('remedy' in verdict ? verdict.remedy : undefined))).toEqual([undefined, NEEDS_PROBE.remedy, undefined]);
  });
});
