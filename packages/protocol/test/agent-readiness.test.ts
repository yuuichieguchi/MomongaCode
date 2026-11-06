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

  it('a target that reports no tool calling runs without tools and says how to choose another target', () => {
    const readiness = agentReadiness({ toolCalling: 'none' });
    expect(readiness.state).toBe('no_tools');
    if (readiness.state !== 'no_tools') return;
    expect(readiness.message).toMatch(/cannot call tools/);
    expect(readiness.remedy).toContain('/model');
    expect(readiness.remedy).not.toMatch(/probe/i);
    expect(readiness.remedy).not.toMatch(/momonga model/);
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
    expect(readiness.message).toContain(reason);
    expect(readiness.remedy).toContain('/model');
  });

  it('reads no target name: two capability sets that differ only outside toolCalling give the same verdict', () => {
    const base = { contextWindow: 8192, maxOutputTokens: 1024, toolCalling: 'none' as const };
    expect(agentReadiness({ ...base, contextWindow: 1 })).toEqual(agentReadiness(base));
  });

  it('names the run error code target_not_ready', () => {
    expect(TARGET_NOT_READY).toBe('target_not_ready');
  });

  it('every non-ready verdict carries a remedy that fits its state', () => {
    const verdicts = [agentReadiness({ toolCalling: 'none' }), agentReadiness({ toolCalling: NEEDS_PROBE }), agentReadiness({ unavailable: 'down' })];
    for (const verdict of verdicts) {
      expect(verdict.state).not.toBe('ready');
      if (verdict.state === 'ready') continue;
      expect(verdict.remedy.length).toBeGreaterThan(0);
    }
  });
});
