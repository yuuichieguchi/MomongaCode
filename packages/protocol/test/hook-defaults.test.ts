import { describe, expect, it } from 'vitest';
import { HOOK_DEFAULT_TIMEOUT_SECONDS, HOOK_EVENTS, hookTimeoutMs, hookTimeoutSecondsOf } from '@momonga/protocol';

describe('the one table of the default hook timeouts, in seconds', () => {
  it('holds 600 seconds by default and 30 seconds for UserPromptSubmit', () => {
    expect(HOOK_DEFAULT_TIMEOUT_SECONDS).toEqual({ default: 600, UserPromptSubmit: 30 });
  });

  it('gives an empty value the default of its event, and keeps a given value', () => {
    expect(HOOK_EVENTS.map((event) => [event, hookTimeoutSecondsOf(event)])).toEqual([
      ['PreToolUse', 600],
      ['PostToolUse', 600],
      ['UserPromptSubmit', 30],
      ['Stop', 600],
      ['SessionStart', 600],
    ]);
    expect(hookTimeoutSecondsOf('UserPromptSubmit', 5)).toBe(5);
    expect(hookTimeoutMs('Stop', {})).toBe(600_000);
  });
});
