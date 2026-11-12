import { describe, expect, it } from 'vitest';
import type { Sandbox, SandboxExit } from '@momonga/sandbox';
import { makeBuiltins, resultOf } from './fixtures.ts';

const NOT_CONFIRMED_NOTE = 'A process of the command could not be confirmed stopped; its marker is kept';

const exitingWith = (exit: SandboxExit): Sandbox => ({
  kind: 'seatbelt',
  spawn: () => ({ pid: 999_981, pgid: 999_981, rebind: () => undefined, stdout: (async function* () {})(), stderr: (async function* () {})(), exited: Promise.resolve(exit) }),
});

describe('the stop outcome of a Bash command', () => {
  it('returns the real result with the note when the stop of its group is not confirmed', async () => {
    const tools = await makeBuiltins({ sandbox: exitingWith({ code: 0, signal: null, stop: 'not_confirmed' }) });
    const result = resultOf(await tools.run('Bash', { command: 'make' }, { mode: 'manual' }, 'allow_once'));
    expect(result.status).toBe('completed');
    expect(result.output).toContain(NOT_CONFIRMED_NOTE);
  });

  it('adds no note when the stop is confirmed', async () => {
    const tools = await makeBuiltins({ sandbox: exitingWith({ code: 0, signal: null, stop: 'confirmed' }) });
    const result = resultOf(await tools.run('Bash', { command: 'make' }, { mode: 'manual' }, 'allow_once'));
    expect(result.output).not.toContain(NOT_CONFIRMED_NOTE);
  });
});
