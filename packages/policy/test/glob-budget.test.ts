import { describe, expect, it } from 'vitest';
import { fakePolicyFilesystem, NEVER_CANCELLED } from '@momonga/testkit';
import type { GlobExpander, GlobExpansion } from '../src/filesystem.ts';
import { MAX_GLOB_MATCHES, createGlobDeadline, expandGlobWord, globBudgetMs, settleGlobs } from '../src/glob-expansion.ts';
import type { GlobDeadline } from '../src/glob-expansion.ts';
import { prepareGlobs } from '../src/glob-preparation.ts';

const CONTEXT = { cwd: '/work/project', home: '/home/user' };

const PREPARING = { ...CONTEXT, signal: new AbortController().signal };

const fixedDeadline = (remaining: number): GlobDeadline => ({ remainingMs: () => remaining });

describe('globBudgetMs: one budget per policy decision, derived from the lease', () => {
  it.each([
    [30_000, 10_000, 20_000],
    [120_000, 40_000, 80_000],
    [3_000, 1_000, 2_000],
  ])('lease %d with heartbeat %d leaves %d', (leaseMs, heartbeatMs, expected) => {
    expect(globBudgetMs({ leaseMs, heartbeatMs })).toBe(expected);
  });
});

describe('createGlobDeadline counts down on the injected clock', () => {
  it('reports the budget left and goes to zero or below once it is spent', () => {
    let now = 1_000;
    const deadline = createGlobDeadline(500, () => now);
    expect(deadline.remainingMs()).toBe(500);
    now = 1_300;
    expect(deadline.remainingMs()).toBe(200);
    now = 1_500;
    expect(deadline.remainingMs()).toBeLessThanOrEqual(0);
  });
});

const commandSubject = (command: string) => ({ kind: 'command', tool: 'Bash', command }) as const;

const recordingExpander = (answer: GlobExpansion = { matches: [] }) => {
  const calls: Array<{ pattern: string; cwd: string; limit: number; deadline: GlobDeadline }> = [];
  const expand: GlobExpander = async (pattern, cwd, limit, deadline) => {    calls.push({ pattern, cwd, limit, deadline });
    return answer;
  };
  return { calls, expand };
};

describe('prepareGlobs spends one deadline across all the glob operands of a decision', () => {
  it('hands the same deadline to the expansion of every brace word and of every operand', async () => {
    const deadline = fixedDeadline(700);
    const { calls, expand } = recordingExpander();
    await prepareGlobs({ expand, platform: 'darwin', subject: commandSubject('cat {a,b}/*.ts c*'), deadline, ...PREPARING });
    expect(calls.map((call) => call.pattern)).toEqual(['a/*.ts', 'b/*.ts', 'c*']);
    expect(calls.every((call) => call.deadline === deadline && call.cwd === CONTEXT.cwd && call.limit === MAX_GLOB_MATCHES)).toBe(true);
  });

  it('expands a pattern that occurs twice once', async () => {
    const { calls, expand } = recordingExpander();
    await prepareGlobs({ expand, platform: 'darwin', subject: commandSubject('cat a* && ls a*'), deadline: fixedDeadline(700), ...PREPARING });
    expect(calls.map((call) => call.pattern)).toEqual(['a*']);
  });

  it('collects the operands of nested commands, wrappers and later segments', async () => {
    const { calls, expand } = recordingExpander();
    const command = 'cat a* | grep x b* ; echo $(ls c*) ; bash -c "cat d*"';
    await prepareGlobs({ expand, platform: 'darwin', subject: commandSubject(command), deadline: fixedDeadline(700), ...PREPARING });
    expect(calls.map((call) => call.pattern).sort()).toEqual(['a*', 'b*', 'c*', 'd*']);
  });

  it('expands nothing for a subject that is not a command, and for a command without globs', async () => {
    const { calls, expand } = recordingExpander();
    await prepareGlobs({ expand, platform: 'darwin', subject: { kind: 'path', tool: 'Read', paths: ['a*'], access: 'read' }, deadline: fixedDeadline(700), ...PREPARING });
    await prepareGlobs({ expand, platform: 'darwin', subject: commandSubject('cat a b'), deadline: fixedDeadline(700), ...PREPARING });
    expect(calls).toEqual([]);
  });

  it('settles the table the decision reads, and rejects a glob that was not prepared', async () => {
    const { expand } = recordingExpander({ matches: ['a.ts'] });
    const table = await prepareGlobs({ expand, platform: 'darwin', subject: commandSubject('cat a*'), deadline: fixedDeadline(700), ...PREPARING });
    const host = { ...fakePolicyFilesystem(), expandGlob: expand };
    const settled = settleGlobs(host, table, NEVER_CANCELLED);
    expect(settled.expandGlob('a*', CONTEXT.cwd, MAX_GLOB_MATCHES)).toEqual({ matches: ['a.ts'] });
    await expect((async () => settled.expandGlob('b*', CONTEXT.cwd, MAX_GLOB_MATCHES))()).rejects.toThrow('was not expanded before the decision');
  });

  it('rethrows an error of the expander', async () => {
    const failure = new Error('EIO: injected');
    const expand: GlobExpander = async () => {
      throw failure;
    };
    await expect(prepareGlobs({ expand, platform: 'darwin', subject: commandSubject('cat a*'), deadline: fixedDeadline(700), ...PREPARING })).rejects.toBe(failure);
  });
});

describe('expandGlobWord reads the prepared expansion with the same prelude', () => {
  it('looks every brace word up, in the form the preparation expanded it', () => {
    const asked: string[] = [];
    const context = {
      ...CONTEXT,
      fs: {
        expandGlob: (pattern: string) => {
          asked.push(pattern);
          return { matches: [] };
        },
      },
    };
    expandGlobWord(context, '{a,b}/*.ts');
    expect(asked).toEqual(['a/*.ts', 'b/*.ts']);
  });
});
