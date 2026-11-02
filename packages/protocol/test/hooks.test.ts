import { describe, expect, it } from 'vitest';
import { hookMatcherError, hookMatcherMatches, hookTimeoutMs, permissionDeniedOutput } from '@momonga/protocol';

describe('hook matchers', () => {
  it('matches everything for an absent, empty or star matcher', () => {
    for (const matcher of [undefined, '', '*']) expect(hookMatcherMatches(matcher, 'Bash')).toBe(true);
  });

  it('treats letters, digits, underscores and bars as an exact list', () => {
    expect(hookMatcherMatches('Edit|Write', 'Write')).toBe(true);
    expect(hookMatcherMatches('Edit|Write', 'MultiEdit')).toBe(false);
  });

  it('treats anything else as a regular expression', () => {
    expect(hookMatcherMatches('mcp__.*', 'mcp__srv__run')).toBe(true);
    expect(hookMatcherMatches('mcp__.*', 'Bash')).toBe(false);
  });

  it('reports an invalid expression', () => {
    expect(hookMatcherError('(')).toMatch(/./);
    expect(hookMatcherError('Bash')).toBeUndefined();
  });
});

describe('hook timeouts', () => {
  it('defaults to 600 seconds and 30 seconds for prompt submission', () => {
    expect(hookTimeoutMs('PreToolUse', {})).toBe(600_000);
    expect(hookTimeoutMs('UserPromptSubmit', {})).toBe(30_000);
    expect(hookTimeoutMs('Stop', { timeout: 5 })).toBe(5000);
  });
});

describe('permission denial output', () => {
  it('prefixes the reason', () => {
    expect(permissionDeniedOutput({ source: 'hook', reason: 'no' })).toBe('Permission denied: no');
  });
});
