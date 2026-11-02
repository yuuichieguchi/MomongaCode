import { describe, expect, it } from 'vitest';
import * as memory from '@momonga/memory';
import type { RunEvent, ToolFile } from '@momonga/protocol';

const PROJECT = '/work/a';
const COMMANDS = ['npm test', 'pytest'];
const MANIFESTS = ['package.json', 'Makefile'];

type Verify = (input: { status: string; events: readonly RunEvent[]; project: string; commands: readonly string[]; manifests: readonly string[] }) => boolean;

const isVerifiedSuccess: Verify = (input) => {
  const found = (memory as Record<string, unknown>)['isVerifiedSuccess'];
  if (typeof found !== 'function') throw new Error('@momonga/memory does not export isVerifiedSuccess');
  return found(input) as boolean;
};

type Step = { name?: string; command?: string; exitCode?: number; output?: string; files?: ToolFile[] };

const journal = (steps: readonly Step[]): RunEvent[] =>
  steps.flatMap((step, index) => {
    const callId = `c${index}`;
    return [
      { type: 'tool.call', seq: 2 * index + 1, callId, name: step.name ?? 'Bash', rawInput: step.command === undefined ? {} : { command: step.command } },
      {
        type: 'tool.completed',
        seq: 2 * index + 2,
        callId,
        status: 'completed',
        output: step.output ?? '',
        ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
        ...(step.files === undefined ? {} : { files: step.files }),
      },
    ] as unknown as RunEvent[];
  });

const verdict = (steps: readonly Step[], status = 'COMPLETED'): boolean =>
  isVerifiedSuccess({ status, events: journal(steps), project: PROJECT, commands: COMMANDS, manifests: MANIFESTS });

const write = (file: string): Step => ({ name: 'Write', files: [{ path: `${PROJECT}/${file}`, sha256: 'aa', access: 'write' }] });

const pass = (command = 'npm test'): Step => ({ command, exitCode: 0 });

const fail = (command = 'npm test'): Step => ({ command, exitCode: 1 });

describe('isVerifiedSuccess', () => {
  it('accepts a completed run whose verification passed after its last write', () => {
    expect(verdict([write('src/a.ts'), pass()])).toBe(true);
  });

  it.each(['FAILED', 'CANCELLED'])('refuses a run that ended %s, so a passing test cannot bless an unfinished run', (status) => {
    expect(verdict([write('src/a.ts'), pass()], status)).toBe(false);
  });

  it('refuses a passing check that a later write made out of date', () => {
    expect(verdict([pass(), write('src/a.ts')])).toBe(false);
  });

  it('refuses a run with no verification command at all', () => {
    expect(verdict([write('src/a.ts')])).toBe(false);
  });

  it('refuses a passing check followed by a failing one after the last write', () => {
    expect(verdict([write('src/a.ts'), pass('npm test'), fail('npm test')])).toBe(false);
    expect(verdict([write('src/a.ts'), pass('npm test'), fail('pytest')])).toBe(false);
  });

  it('takes the most recent verification command, so a fix after a failure counts', () => {
    expect(verdict([write('src/a.ts'), fail(), pass()])).toBe(true);
  });

  it('ignores a command that is not a verification command when it picks the most recent one', () => {
    expect(verdict([write('src/a.ts'), pass(), { command: 'ls missing', exitCode: 2 }])).toBe(true);
  });

  it.each(['npm test -- --grep nothing', 'npm test ', 'npm  test', 'echo npm test', 'npm test || true'])('requires exact equality, so %j verifies nothing', (command) => {
    expect(verdict([write('src/a.ts'), pass(command)])).toBe(false);
  });

  it('reads the exit code from the event and never from the output text', () => {
    expect(verdict([write('src/a.ts'), { command: 'npm test', exitCode: 1, output: 'exit code 0\nall tests passed' }])).toBe(false);
    expect(verdict([write('src/a.ts'), { command: 'npm test', output: 'exit code 0\nall tests passed' }])).toBe(false);
  });

  it('counts only Bash, so another tool with a command field verifies nothing', () => {
    expect(verdict([write('src/a.ts'), { name: 'McpTool', command: 'npm test', exitCode: 0 }])).toBe(false);
  });

  it('refuses a run that wrote a manifest, because a manifest can change what the command does', () => {
    expect(verdict([write('package.json'), pass()])).toBe(false);
    expect(verdict([write('Makefile'), write('src/a.ts'), pass()])).toBe(false);
  });

  it('accepts a run that only read a manifest', () => {
    expect(verdict([{ name: 'Read', files: [{ path: `${PROJECT}/package.json`, sha256: 'aa', access: 'read' }] }, pass()])).toBe(true);
  });

  it('does not let a read after the check count as a write', () => {
    expect(verdict([pass(), { name: 'Read', files: [{ path: `${PROJECT}/src/a.ts`, sha256: 'aa', access: 'read' }] }])).toBe(true);
  });

  it('verifies nothing with an empty command list', () => {
    expect(isVerifiedSuccess({ status: 'COMPLETED', events: journal([pass()]), project: PROJECT, commands: [], manifests: [] })).toBe(false);
  });
});
