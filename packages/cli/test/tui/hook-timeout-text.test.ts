import { describe, expect, it } from 'vitest';
import { HOOK_TIMEOUT_TITLE, hookLine } from '../../src/tui/commands/hooks.ts';

const held = (event: string, timeout?: number) => ({ layer: 'user' as const, event, group: 0, hook: 0, matcher: undefined, command: { type: 'command' as const, command: 'echo checked', ...(timeout === undefined ? {} : { timeout }) } });

describe('the hook timeout is stated in seconds with its default (cli-tui-C44, R22-Q19)', () => {
  it('names the unit and the default of an empty value in the label', () => {
    expect(HOOK_TIMEOUT_TITLE).toBe('Timeout, seconds (empty: 600, or 30 for UserPromptSubmit)');
  });

  it('shows a hook with no timeout with the default that applies, in seconds', () => {
    expect(hookLine(held('PreToolUse'))).toBe('PreToolUse  *  echo checked  timeout 600 s  user');
    expect(hookLine(held('UserPromptSubmit'))).toBe('UserPromptSubmit  *  echo checked  timeout 30 s  user');
    expect(hookLine(held('Stop', 5))).toBe('Stop  *  echo checked  timeout 5 s  user');
  });
});
