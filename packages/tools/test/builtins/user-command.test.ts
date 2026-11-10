import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { parseRule } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import { USER_SHELL_OUTPUT_BYTES } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { runUserCommand } from '@momonga/tools';
import type { UserCommandOutcome } from '@momonga/tools';
import { BASE_ENV, isAlive, makeBuiltins, trackGroup, waitFor } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const denyOf = (tools: Builtins, text: string): PermissionRule =>
  parseRule(text, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: tools.layout.project, home: tools.layout.home, cwd: tools.layout.project });

type Ran = { outcome: UserCommandOutcome; streamed: string; groups: number[] };

const runAsUser = async (tools: Builtins, command: string, rules: PermissionRule[] = [], signal: AbortSignal = new AbortController().signal, onText: (text: string) => void = () => undefined): Promise<Ran> => {
  const facts = tools.batch('Bash', { command }, { rules });
  const unsandboxed = createUnsandboxed({ killGraceMs: 300 });
  const groups: number[] = [];
  let streamed = '';
  const outcome = await runUserCommand({
    command,
    cwd: tools.layout.project,
    env: BASE_ENV,
    signal,
    refusal: (asked) => tools.executor.userRefusal({ tool: 'Bash', command: asked }, facts),
    spawn: (spawned, spawnSignal) => {
      const child = unsandboxed.spawn(spawned, facts.sandboxPolicy, spawnSignal);
      groups.push(child.pgid);
      trackGroup(child.pgid);
      return child;
    },
    onOutput: (text) => {
      streamed += text;
      onText(text);
    },
  });
  return { outcome, streamed, groups };
};

describe('a command the person typed', () => {
  it('runs with no approval and returns the exit code and the output, streamed as it arrives', async () => {
    const tools = await makeBuiltins();
    const { outcome, streamed } = await runAsUser(tools, 'echo hello; echo problem 1>&2');
    expect(outcome).toEqual({ kind: 'ran', exitCode: 0, output: expect.stringContaining('hello') });
    expect(streamed).toContain('hello');
    expect(streamed).toContain('problem');
  });

  it('runs in the working directory it is given and reports a failing exit code', async () => {
    const tools = await makeBuiltins();
    tools.write('here.txt', 'x');
    const { outcome } = await runAsUser(tools, 'ls; exit 3');
    expect(outcome).toEqual({ kind: 'ran', exitCode: 3, output: 'here.txt' });
  });

  it('is refused by a deny rule of the Bash tool and nothing is started', async () => {
    const tools = await makeBuiltins();
    const { outcome, groups } = await runAsUser(tools, 'echo forbidden', [denyOf(tools, 'Bash(echo:*)')]);
    expect(outcome.kind).toBe('refused');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('Bash(echo:*)') });
    expect(groups).toEqual([]);
  });

  it('is refused when it reads a path a Read deny rule covers', async () => {
    const tools = await makeBuiltins();
    tools.write('.env', 'SECRET=1');
    const { outcome, groups } = await runAsUser(tools, 'cat .env', [denyOf(tools, 'Read(.env)')]);
    expect(outcome.kind).toBe('refused');
    expect(groups).toEqual([]);
  });

  it('keeps the head and the tail of a long output with a marker between them', async () => {
    const tools = await makeBuiltins();
    const { outcome } = await runAsUser(tools, 'printf START; head -c 200000 /dev/zero | tr "\\0" a; printf END');
    if (outcome.kind !== 'ran') throw new Error('the command did not run');
    expect(outcome.output.startsWith('START')).toBe(true);
    expect(outcome.output.endsWith('END')).toBe(true);
    expect(outcome.output).toMatch(/\n\[… \d+ bytes omitted …\]\n/);
    expect(Buffer.byteLength(outcome.output)).toBeLessThanOrEqual(USER_SHELL_OUTPUT_BYTES + 64);
  });

  it('stops with its whole process group when the person interrupts it', async () => {
    const tools = await makeBuiltins();
    const interrupt = new AbortController();
    const { outcome, groups: started } = await runAsUser(tools, 'echo started; sleep 600 & sleep 600', [], interrupt.signal, () => interrupt.abort());
    expect(outcome.kind).toBe('ran');
    expect(outcome).toMatchObject({ exitCode: null });
    expect(await waitFor(() => started.every((pgid) => !isAlive(-pgid)))).toBe(true);
  });
});

describe('the floors of a file the person names', () => {
  it('refuses a path a Read deny rule covers and allows another', async () => {
    const tools = await makeBuiltins();
    const secret = tools.write('.env', 'SECRET=1');
    const open = tools.write('notes.txt', 'n');
    const facts = tools.batch('Read', { file_path: secret }, { rules: [denyOf(tools, 'Read(.env)')] });
    expect(await tools.executor.userRefusal({ tool: 'Read', path: secret }, facts)).toContain('Read(.env)');
    expect(await tools.executor.userRefusal({ tool: 'Read', path: open }, facts)).toBeUndefined();
  });
});
