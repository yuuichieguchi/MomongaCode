import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { BackgroundJobs, ToolHooks } from '@momonga/tools';
import type { SandboxPolicy } from '@momonga/sandbox';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { makeLayout, policyFor, ruleFor } from './helpers.ts';
import { realSandbox, recordingSandbox, scratchRootOf } from './read-only-support.ts';
import type { RecordedSpawn } from './read-only-support.ts';

const setup = async (jobs?: BackgroundJobs) => {
  const scratch = scratchRootOf(makeLayout().root);
  const recorded = recordingSandbox(realSandbox(scratch));
  const built = await makeBuiltins({ sandbox: recorded.sandbox, ...(jobs === undefined ? {} : { jobs }) });
  return { ...built, spawns: recorded.spawns };
};

const hooksAnswering = (decision: 'allow' | 'ask'): ToolHooks =>
  ({ matchesPreToolUse: () => true, preToolUse: async () => ({ decision }), postToolUse: async () => undefined }) as unknown as ToolHooks;

const expectFullPolicy = (policy: SandboxPolicy | undefined, project: string): void => {
  expect(policy?.writableRoots).toContain(project);
};

const expectReadOnlyCall = (spawn: RecordedSpawn | undefined): void => {
  expect(spawn?.policy.writableRoots).toEqual([]);
  expect(spawn?.command.tmpDir).toBeUndefined();
};

describe('rule 2: the sandbox policy of each path that approves a Bash call', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.each(['default', 'plan', 'acceptEdits'] as const)('a read-only analysis in %s mode leaves no path writable but the scratch directory of the spawn', async (mode) => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'pwd' }, { mode }));
    expectReadOnlyCall(built.spawns[0]);
  });

  it('the network setting and the deny lists of the batch stay as they are', async () => {
    const built = await setup();
    const sandboxPolicy: SandboxPolicy = { ...built.sandboxPolicy, network: 'allow' };
    resultOf(await built.run('Bash', { command: 'pwd' }, { sandboxPolicy }));
    expect(built.spawns[0]?.policy).toEqual({ ...sandboxPolicy, writableRoots: [] });
  });

  it('a file rule that allows writes outside the workspace does not widen the call', async () => {
    const built = await setup();
    const rules = [ruleFor(built.layout)('allow', `Edit(/${built.layout.outside}/**)`)];
    const sandboxPolicy = policyFor({ layout: built.layout, rules, tmpDir: built.tmpDir });
    expect(sandboxPolicy.fileRules.entries.some((entry) => entry.widening)).toBe(true);
    resultOf(await built.run('Bash', { command: 'pwd' }, { rules, sandboxPolicy }));
    expect(built.spawns[0]?.policy.fileRules.entries.some((entry) => entry.widening)).toBe(false);
    expect(built.spawns[0]?.policy.fileRules.entries).toHaveLength(sandboxPolicy.fileRules.entries.length);
  });

  it('a file rule that allows writes outside the workspace still widens a call that is not read-only', async () => {
    const built = await setup();
    const rules = [ruleFor(built.layout)('allow', `Edit(/${built.layout.outside}/**)`), ruleFor(built.layout)('allow', 'Bash(pwd:*)')];
    const sandboxPolicy = policyFor({ layout: built.layout, rules, tmpDir: built.tmpDir });
    resultOf(await built.run('Bash', { command: 'pwd' }, { rules, sandboxPolicy }));
    expect(built.spawns[0]?.policy.fileRules.entries.some((entry) => entry.widening)).toBe(true);
  });

  it('a hook that allows a read-only command does not widen it', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'pwd' }, { hooks: hooksAnswering('allow') }));
    expectReadOnlyCall(built.spawns[0]);
  });

  it('a background job started from a read-only analysis gets the read-only policy and environment', async () => {
    const started: Array<Promise<unknown>> = [];
    const jobs = {
      start: async (request: { spawn(marker: string, signal: AbortSignal): { exited: Promise<unknown> } }) => {
        started.push(request.spawn(path.join(built.layout.root, 'job-marker'), new AbortController().signal).exited);
        return { jobId: 'job-1' };
      },
    } as unknown as BackgroundJobs;
    const built = await setup(jobs);
    resultOf(await built.run('Bash', { command: 'pwd', run_in_background: true }));
    await Promise.all(started);
    expectReadOnlyCall(built.spawns[0]);
    expect(built.spawns[0]?.command.env['GIT_OPTIONAL_LOCKS']).toBe('0');
  });

  it('an allow rule keeps the policy of the batch', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'pwd' }, { rules: [ruleFor(built.layout)('allow', 'Bash(pwd:*)')] }));
    expectFullPolicy(built.spawns[0]?.policy, built.layout.project);
    expect(built.spawns[0]?.command.env['GIT_CONFIG_COUNT']).toBeUndefined();
  });

  it('bypassPermissions keeps the policy of the batch', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'pwd' }, { mode: 'bypassPermissions' }));
    expectFullPolicy(built.spawns[0]?.policy, built.layout.project);
  });

  it('acceptEdits keeps the policy of the batch for an edit', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'mkdir fresh' }, { mode: 'acceptEdits' }));
    expectFullPolicy(built.spawns[0]?.policy, built.layout.project);
  });

  it('a hook that allows an asked command keeps the policy of the batch', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'mkdir fresh' }, { hooks: hooksAnswering('allow') }));
    expectFullPolicy(built.spawns[0]?.policy, built.layout.project);
  });

  it('the auto classifier keeps the policy of the batch', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'mkdir fresh' }, { mode: 'auto', classifier: { classify: async () => 'allow' } }));
    expectFullPolicy(built.spawns[0]?.policy, built.layout.project);
  });

  it('a person approving an asked command keeps the policy of the batch', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'mkdir fresh' }, {}, 'allow_once'));
    expectFullPolicy(built.spawns[0]?.policy, built.layout.project);
  });

  it('a person approving a read-only command that a hook sent to a person keeps the policy of the batch', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'pwd' }, { hooks: hooksAnswering('ask') }, 'allow_once'));
    expectFullPolicy(built.spawns[0]?.policy, built.layout.project);
  });
});
