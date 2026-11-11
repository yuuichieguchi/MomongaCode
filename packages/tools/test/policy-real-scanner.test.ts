import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeRealWorkspace } from './real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const HIDDEN_TOUCH = "echo $(ls # ) '\ntouch pwn\n) # '";
const HIDDEN_TOUCH_QUOTED = 'echo "$(ls # ) \'\nrm -rf src\n) # \'"';

describe('one scanner: a comment inside $() ends at the newline, as in real /bin/bash', () => {
  it('bash runs the command hidden behind a comment that contains a parenthesis', () => {
    const workspace = makeRealWorkspace();
    workspace.runBash(HIDDEN_TOUCH);
    expect(workspace.exists('pwn')).toBe(true);
  });

  it.each([HIDDEN_TOUCH, HIDDEN_TOUCH_QUOTED])('does not allow %j in manual mode', async (command) => {
    const workspace = makeRealWorkspace();
    expect((await workspace.decide(command, { mode: 'manual' })).kind).toBe('ask');
  });

  it('denies the hidden command under a deny rule for it', async () => {
    const workspace = makeRealWorkspace();
    const decision = await workspace.decide(HIDDEN_TOUCH, { rules: [['deny', 'Bash(touch:*)']] });
    expect((await decision).kind).toBe('deny');
  });

  it('keeps a quoted parenthesis and a quoted hash inside a substitution literal', async () => {
    const workspace = makeRealWorkspace();
    expect(workspace.runBash("echo $(echo ')' '#' a)").stdout).toBe(") # a\n");
    expect((await workspace.decide("echo $(echo ')' '#' a)")).kind).toBe('allow');
  });
});
