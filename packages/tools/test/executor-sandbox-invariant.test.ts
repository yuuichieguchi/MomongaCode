import { describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, ruleEnforcementOf } from '@momonga/foundation';
import type { FileRuleSet } from '@momonga/foundation';
import { computeFileRules, parseRule } from '@momonga/policy';
import type { PermissionRule, RuleEffect } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { SandboxPolicyError } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import type { BatchInput, CallOutcome } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { ApprovalSpec, Harness } from './harness.ts';
import { keyFor, minimalPolicyFor } from './helpers.ts';
import { testProbes } from '@momonga/testkit';

const stream = (): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {},
});

const recordingSandbox = (kind: Sandbox['kind']) => {
  const policies: SandboxPolicy[] = [];
  const sandbox: Sandbox = {
    kind,
    spawn: (_command, policy): SandboxedProcess => {
      policies.push(policy);
      return { pid: 0, pgid: 0, rebind: () => undefined, stdout: stream(), stderr: stream(), exited: Promise.resolve({ code: 0, signal: null }) };
    },
  };
  return { sandbox, policies };
};

const bashLike = () =>
  makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec', subjectKind: 'command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    subject: (input) => ({ kind: 'command', tool: 'Bash', command: String(input['command']) }),
    execute: async (input, ctx) => {
      const child = await ctx.sandbox.spawn({ argv: ['/bin/bash', '-c', String(input['command'])], cwd: ctx.session.cwd, env: {} }, ctx.sandboxPolicy, ctx.signal);
      const exit = await (await child).exited;
      return { status: exit.code === 0 ? 'completed' : 'failed', output: 'ran' };
    },
  });

const PERL = `perl -e 'open(F, ">>.env"); print F "x"'`;

const ruleOf = (harness: Harness, effect: RuleEffect, text: string): PermissionRule =>
  parseRule(text, { effect, origin: 'user', source: 'user-settings', settingsRoot: harness.layout.project, home: harness.layout.home, cwd: harness.layout.project });

type Scenario = {
  harness: Harness;
  sandbox: Sandbox;
  mode: PermissionMode;
  rules: PermissionRule[];
  fileRules: FileRuleSet;
  roots?: string[];
  command: string;
  approval?: ApprovalSpec;
  callId?: string;
};

const batchOf = async ({ harness, sandbox, mode, rules, fileRules, roots, command, approval, callId }: Scenario): Promise<BatchInput> =>
  harness.input(await toolSetOf(bashLike()), [call(callId ?? 'c1', 'Bash', { command }, approval)], {
    mode,
    rules,
    sandbox,
    roots: roots ?? [harness.layout.project],
    sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), fileRules } as SandboxPolicy,
  });

const runScenario = async (scenario: Scenario): Promise<CallOutcome | undefined> => {
  const [outcome] = await scenario.harness.executor.runBatch(await batchOf(scenario));
  return outcome;
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

describe('sandbox none keeps human approval for every command (pins)', () => {
  it('asks in bypassPermissions without rules and names the missing sandbox', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('none');
    const outcome = await runScenario({ harness, sandbox, mode: 'bypassPermissions', rules: [], fileRules: await computeFileRules([], [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()), command: PERL });
    expect(outcome).toMatchObject({ kind: 'needs_approval', decision: { kind: 'ask', source: 'mode' } });
    expect((outcome as { decision: { reason: string } }).decision.reason).toContain('no sandbox is available');
    expect(outcome).not.toHaveProperty('suggestedRule');
    expect(policies).toEqual([]);
  });

  it('asks in bypassPermissions even with a matching Bash allow rule', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('none');
    const outcome = await runScenario({ harness, sandbox, mode: 'bypassPermissions', rules: [ruleOf(harness, 'allow', 'Bash(perl:*)')], fileRules: await computeFileRules([ruleOf(harness, 'allow', 'Bash(perl:*)')], [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()), command: PERL });
    expect(outcome?.kind).toBe('needs_approval');
    expect(policies).toEqual([]);
  });

  it('asks again in manual mode after an earlier allow_always', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('none');
    const first = await runScenario({ harness, sandbox, mode: 'manual', rules: [], fileRules: await computeFileRules([], [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()), command: PERL, approval: 'allow_always', callId: 'c1' });
    expect(first).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(policies).toHaveLength(1);
    const again = await runScenario({ harness, sandbox, mode: 'manual', rules: [ruleOf(harness, 'allow', 'Bash(perl:*)')], fileRules: await computeFileRules([ruleOf(harness, 'allow', 'Bash(perl:*)')], [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()), command: PERL, callId: 'c2' });
    expect(again?.kind).toBe('needs_approval');
    expect(policies).toHaveLength(1);
  });

  it('fails a statically visible write to a denied file', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('none');
    const rules = [ruleOf(harness, 'deny', 'Write(.env)')];
    const outcome = await runScenario({ harness, sandbox, mode: 'bypassPermissions', rules, fileRules: await computeFileRules(rules, [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()), command: 'echo x > .env' });
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output.startsWith('Permission denied')).toBe(true);
    expect(policies).toEqual([]);
  });

  it('spawns an approved command', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('none');
    const rules = [ruleOf(harness, 'deny', 'Write(.env)')];
    const outcome = await runScenario({ harness, sandbox, mode: 'bypassPermissions', rules, fileRules: await computeFileRules(rules, [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()), command: PERL, approval: 'allow_once' });
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(policies).toHaveLength(1);
  });
});

describe('seatbelt batches carry the file rules of their own rules', () => {
  it('spawns with a policy whose entries contain the deny rule', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('seatbelt');
    const rules = [ruleOf(harness, 'deny', 'Write(.env)')];
    const roots = [harness.layout.project];
    await runScenario({ harness, sandbox, mode: 'bypassPermissions', rules, fileRules: await computeFileRules(rules, roots, null, ruleEnforcementOf('none'), testProbes()), command: PERL });
    expect(policies).toHaveLength(1);
    const entries = (policies[0] as SandboxPolicy & { fileRules: FileRuleSet }).fileRules.entries;
    expect(entries).toEqual([expect.objectContaining({ ruleIndex: 0, tool: 'Edit', access: 'write', effect: 'deny' })]);
  });

  it('throws file_rules_stale before any spawn when the policy carries EMPTY_FILE_RULES', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('seatbelt');
    const error = await rejectionOf(
      harness.executor.runBatch(
        await batchOf({ harness, sandbox, mode: 'bypassPermissions', rules: [ruleOf(harness, 'deny', 'Write(.env)')], fileRules: EMPTY_FILE_RULES, command: PERL }),
      ),
    );
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect((error as SandboxPolicyError).code).toBe('file_rules_stale');
    expect(policies).toEqual([]);
    expect(harness.idempotency.log).toEqual([]);
  });

  const variants: Array<[string, (harness: Harness) => Promise<{ rules: PermissionRule[]; built: FileRuleSet }>]> = [
    [
      'one deny rule',
      async (harness) => ({
        rules: [ruleOf(harness, 'deny', 'Write(.env)')],
        built: await computeFileRules([ruleOf(harness, 'deny', 'Write(.envrc)')], [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()),
      }),
    ],
    [
      'one exception',
      async (harness) => ({
        rules: [ruleOf(harness, 'deny', 'Read(*.env)')],
        built: await computeFileRules([{ ...ruleOf(harness, 'deny', 'Read(*.env)'), exceptions: ['sample.env'] } as PermissionRule], [harness.layout.project], null, ruleEnforcementOf('none'), testProbes()),
      }),
    ],
    [
      'one root',
      async (harness) => ({
        rules: [ruleOf(harness, 'deny', 'Write(.env)')],
        built: await computeFileRules([ruleOf(harness, 'deny', 'Write(.env)')], [harness.layout.project, harness.layout.outside], null, ruleEnforcementOf('none'), testProbes()),
      }),
    ],
  ];

  it.each(variants)('throws file_rules_stale when the policy was built from rules that differ in %s', async (_label, make) => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('seatbelt');
    const { rules, built } =await  await make(harness);
    const error = await rejectionOf(harness.executor.runBatch(await batchOf({ harness, sandbox, mode: 'manual', rules, fileRules: built, command: PERL, approval: 'allow_once' })));
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect((error as SandboxPolicyError).code).toBe('file_rules_stale');
    expect(policies).toEqual([]);
  });

  it('spawns when the policy was built from the same rules and roots', async () => {
    const harness = makeHarness();
    const { sandbox, policies } = recordingSandbox('seatbelt');
    const rules = [ruleOf(harness, 'deny', 'Write(.env)'), { ...ruleOf(harness, 'deny', 'Read(*.env)'), exceptions: ['sample.env'] } as PermissionRule];
    const built = await computeFileRules(rules, [harness.layout.project], null, ruleEnforcementOf('none'), testProbes());
    const outcome = await runScenario({ harness, sandbox, mode: 'manual', rules, fileRules: built, command: PERL, approval: 'allow_once' });
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(policies).toHaveLength(1);
    expect((policies[0] as SandboxPolicy & { fileRules: FileRuleSet }).fileRules.fingerprint).toBe(built.fingerprint);
  });
});

describe('recovery batches', () => {
  it('reconciles a recorded Bash call with empty rules and no sandbox', async () => {
    const harness = makeHarness();
    const key = keyFor('run-1', 1, 'c1');
    harness.idempotency.seed(key, 'PENDING', { tool: 'Bash' });
    const reconciled: string[] = [];
    const tool = makeTool('Bash', {
      kind: 'execute',
      sideEffect: 'exec', subjectKind: 'none',
      reconcile: async () => {
        reconciled.push(key);
        return { outcome: 'already_applied', output: 'reconciled' };
      },
    });
    const { sandbox: _sandbox, sandboxPolicy: _policy, ...recovery } =await  await harness.input(await toolSetOf(tool), [call('c1', 'Bash')], { recoverOnly: true, rules: [] });
    const [outcome] = await harness.executor.runBatch(recovery as BatchInput);
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'already_applied', result: { status: 'completed', output: 'reconciled' } });
    expect(reconciled).toEqual([key]);
    expect(harness.idempotency.stateOf(key)).toBe('COMPLETED');
  });
});
