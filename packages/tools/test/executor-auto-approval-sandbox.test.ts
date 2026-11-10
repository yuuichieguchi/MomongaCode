import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET, fileRuleFingerprint } from '@momonga/foundation';
import { fileRuleSpecsOf } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { fakeSandbox, noneSandbox, ruleFor } from './helpers.ts';

const commandTool = (command: string, runs: string[]) =>
  makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec', subjectKind: 'command',
    subject: () => ({ kind: 'command', tool: 'Bash', command }),
    execute: async () => {
      runs.push(command);
      return { status: 'completed', output: 'ran' };
    },
  });

const CASES: ReadonlyArray<{ id: string; command: string; rules: (harness: ReturnType<typeof makeHarness>) => PermissionRule[] }> = [
  { id: 'R1', command: 'ls src', rules: () => [] },
  {
    id: 'C1',
    command: 'echo x > ~root/.bashrc',
    rules: (harness) => [ruleFor(harness.layout)('allow', 'Bash(echo:*)'), ruleFor(harness.layout)('deny', 'Write(~/.bashrc)')],
  },
];

describe('sandbox none forces approval for every Bash command (4.6, 5.11)', () => {
  for (const { id, command, rules } of CASES) {
    for (const mode of ['manual', 'bypassPermissions'] as PermissionMode[]) {
      it(`${id} ${command} needs approval in ${mode} without a kernel`, async () => {
        const harness = makeHarness();
        fs.mkdirSync(path.join(harness.layout.project, 'src'));
        const runs: string[] = [];
        const [outcome] = await harness.executor.runBatch(
          harness.input(await toolSetOf(commandTool(command, runs)), [call('c1', 'Bash')], { mode, rules: rules(harness), sandbox: noneSandbox }),
        );
        expect(outcome).toMatchObject({ callId: 'c1', kind: 'needs_approval' });
        expect(runs).toEqual([]);
      });
    }
  }

  it('R1 runs without approval in default under the seatbelt sandbox', async () => {
    const harness = makeHarness();
    fs.mkdirSync(path.join(harness.layout.project, 'src'));
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(commandTool('ls src', runs)), [call('c1', 'Bash')], { mode: 'manual', sandbox: fakeSandbox, env: { PATH: '/usr/bin:/bin' } }));
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'completed' } });
    expect(runs).toEqual(['ls src']);
  });
});

describe('the harness batch keeps the R1a fingerprint with the protected set added (5.11)', () => {
  it('carries a file-rule fingerprint equal to the fingerprint of the batch rules and the empty protected set', async () => {
    const harness = makeHarness();
    const rules = [ruleFor(harness.layout)('deny', 'Read(.env)')];
    const batch = harness.input(await toolSetOf(), [], { rules });
    const roots = [harness.layout.project];
    expect(batch.sandboxPolicy.protectedSet).toEqual(EMPTY_PROTECTED_SET);
    expect(batch.sandboxPolicy.fileRules.fingerprint).toBe(fileRuleFingerprint(fileRuleSpecsOf(rules, roots), roots, null));
  });
});
