import { describe, expect, it } from 'vitest';
import * as memory from '@momonga/memory';
import type { ApprovalBasis, RunEvent, ToolFile } from '@momonga/protocol';

const PROJECT = '/work/a';
const COMMANDS = ['npm test', 'pytest'];
const MANIFESTS = ['package.json', 'Makefile'];

type Verify = (input: { status: string; events: readonly RunEvent[]; project: string; commands: readonly string[]; manifests: readonly string[] }) => boolean;

const isVerifiedSuccess: Verify = (input) => {
  const found = (memory as Record<string, unknown>)['isVerifiedSuccess'];
  if (typeof found !== 'function') throw new Error('@momonga/memory does not export isVerifiedSuccess');
  return found(input) as boolean;
};

type Step = { name?: string; command?: string; exitCode?: number; output?: string; files?: ToolFile[]; basis?: ApprovalBasis | 'unrecorded' };

const journal = (steps: readonly Step[]): RunEvent[] =>
  steps.flatMap((step, index) => {
    const callId = `c${index}`;
    return [
      { type: 'tool.call', seq: 3 * index + 1, callId, name: step.name ?? 'Bash', rawInput: step.command === undefined ? {} : { command: step.command } },
      { type: 'tool.started', seq: 3 * index + 2, callId, idemKey: `k${index}`, ...(step.basis === 'unrecorded' ? {} : { basis: step.basis ?? 'read_only' }) },
      {
        type: 'tool.completed',
        seq: 3 * index + 3,
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

  it('matches a manifest by base name at any depth, because a nested one changes what the command does', () => {
    expect(verdict([write('packages/web/package.json'), pass()])).toBe(false);
    expect(verdict([write('tools/build/Makefile'), pass()])).toBe(false);
    expect(verdict([write('src/package.json.bak'), pass()])).toBe(true);
    expect(verdict([write('docs/my-package.json'), pass()])).toBe(true);
  });

  const reconciled = (outcome: 'already_applied' | 'not_applied' | 'unknown', file = 'src/a.ts'): RunEvent[] =>
    [
      { type: 'tool.call', seq: 1, callId: 'r1', name: 'Write', kind: 'edit', rawInput: { file_path: `${PROJECT}/${file}` }, locations: [{ path: `${PROJECT}/${file}` }] },
      { type: 'tool.reconciled', seq: 2, callId: 'r1', outcome, output: 'interrupted' },
    ] as unknown as RunEvent[];

  const checked = (events: RunEvent[]): boolean => isVerifiedSuccess({ status: 'COMPLETED', events, project: PROJECT, commands: COMMANDS, manifests: MANIFESTS });

  it('counts a reconciled write as a write, because its outcome is unknown and a later check is needed', () => {
    expect(checked([...journal([pass()]), ...reconciled('unknown')])).toBe(false);
    expect(checked([...journal([pass()]), ...reconciled('already_applied')])).toBe(false);
    expect(checked([...reconciled('unknown'), ...journal([pass()])])).toBe(true);
    expect(checked([...reconciled('already_applied'), ...journal([pass()])])).toBe(true);
  });

  it('does not count a reconciled write that was not applied', () => {
    expect(checked([...journal([pass()]), ...reconciled('not_applied')])).toBe(true);
  });

  it('refuses a run whose reconciled write may have changed a manifest', () => {
    expect(checked([...reconciled('unknown', 'package.json'), ...journal([pass()])])).toBe(false);
  });

  it('accepts a run that only read a manifest', () => {
    expect(verdict([{ name: 'Read', files: [{ path: `${PROJECT}/package.json`, sha256: 'aa', access: 'read' }] }, pass()])).toBe(true);
  });

  it('does not let a read after the check count as a write', () => {
    expect(verdict([pass(), { name: 'Read', files: [{ path: `${PROJECT}/src/a.ts`, sha256: 'aa', access: 'read' }] }])).toBe(true);
  });

  describe('a Bash call that is not read only', () => {
    const edit = (command = "sed -i 's/\"test\": \".*\"/\"test\": \"true\"/' package.json"): Step => ({ command, exitCode: 0, basis: 'person' });

    it('counts as a write of unknown paths, so a check after it does not verify the run', () => {
      expect(verdict([edit(), pass()])).toBe(false);
      expect(verdict([write('src/a.ts'), edit(), pass()])).toBe(false);
    });

    it('makes the run unverified wherever it stands, even before the write of the last file and the check', () => {
      expect(verdict([pass(), edit()])).toBe(false);
      expect(verdict([edit(), write('src/a.ts'), pass()])).toBe(false);
    });

    it('does not matter for a read only call between the write and the check', () => {
      expect(verdict([write('src/a.ts'), { command: 'git status', exitCode: 0, basis: 'read_only' }, pass()])).toBe(true);
    });

    it.each(['rule', 'mode', 'hook', 'classifier', 'person'] as const)('counts when the approval basis is %s', (basis) => {
      expect(verdict([{ command: 'rm -rf build', exitCode: 0, basis }, pass()])).toBe(false);
    });

    it('counts when no approval basis was recorded, because the call cannot be shown to be read only', () => {
      expect(verdict([{ command: 'git status', exitCode: 0, basis: 'unrecorded' }, pass()])).toBe(false);
    });

    it('counts even when the call failed, because a failed command may have changed a file first', () => {
      expect(verdict([{ command: 'sed -i s/a/b/ package.json', exitCode: 1, basis: 'person' }, pass()])).toBe(false);
    });

    it('does not count when it is exactly a verification command', () => {
      expect(verdict([write('src/a.ts'), { command: 'npm test', exitCode: 0, basis: 'person' }])).toBe(true);
      expect(verdict([write('src/a.ts'), { command: 'npm test', exitCode: 0, basis: 'unrecorded' }])).toBe(true);
    });

    it('counts when the command only contains a verification command', () => {
      expect(verdict([write('src/a.ts'), { command: 'sed -i s/a/b/ package.json && npm test', exitCode: 0, basis: 'person' }])).toBe(false);
    });

    it('does not count when the permission was denied, because nothing ran', () => {
      const denied: RunEvent[] = [
        { type: 'tool.call', seq: 1, callId: 'd1', name: 'Bash', rawInput: { command: 'rm -rf build' } },
        { type: 'tool.completed', seq: 2, callId: 'd1', status: 'completed', output: 'denied', denial: { source: 'rule', message: 'no' } },
      ] as unknown as RunEvent[];
      expect(checked([...denied, ...journal([pass()])])).toBe(true);
    });

    it('counts a reconciled call whose effect is unknown', () => {
      const interrupted = (outcome: 'already_applied' | 'not_applied' | 'unknown'): RunEvent[] =>
        [
          { type: 'tool.call', seq: 1, callId: 'x1', name: 'Bash', kind: 'execute', rawInput: { command: 'rm -rf build' } },
          { type: 'tool.started', seq: 2, callId: 'x1', idemKey: 'k', basis: 'person' },
          { type: 'tool.reconciled', seq: 3, callId: 'x1', outcome, output: 'interrupted' },
        ] as unknown as RunEvent[];
      expect(checked([...interrupted('unknown'), ...journal([pass()])])).toBe(false);
      expect(checked([...interrupted('already_applied'), ...journal([pass()])])).toBe(false);
      expect(checked([...interrupted('not_applied'), ...journal([pass()])])).toBe(true);
    });
  });

  it('verifies nothing with an empty command list', () => {
    expect(isVerifiedSuccess({ status: 'COMPLETED', events: journal([pass()]), project: PROJECT, commands: [], manifests: [] })).toBe(false);
  });
});
