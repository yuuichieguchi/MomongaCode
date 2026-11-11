import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionSubject } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import type { CallOutcome, ResultOutcome } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { ruleFor } from './helpers.ts';

const COMMAND_SCHEMA = {
  type: 'object',
  properties: { command: { type: 'string' }, network: { type: 'string' } },
  required: ['command'],
  additionalProperties: false,
} as const;

const SUPERSEDED = [{ operation: 'GitPush', argv: ['git', 'push'] }];
const MANDATE = { supersededForms: SUPERSEDED, coveredPrograms: [] };

type Extra = { mode?: PermissionMode; rules?: string[][]; mandate?: typeof MANDATE; sandboxNetwork?: 'ask' | 'allow' | 'deny' };

const denialOf = async (input: Record<string, unknown>, extra: Extra, tool: 'Bash' | 'Write' = 'Bash'): Promise<ResultOutcome['result']['denial']> => {
  const harness = makeHarness();
  const bash = makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec',
    subjectKind: 'command',
    inputSchema: COMMAND_SCHEMA,
    subject: (given): Extract<PermissionSubject, { kind: 'command' }> => ({
      kind: 'command',
      tool: 'Bash',
      command: String(given['command']),
      ...(given['network'] === 'open' ? { network: 'open' as const } : {}),
    }),
    execute: async () => ({ status: 'completed' as const, output: 'ran' }),
  });
  const write = makeTool('Write', {
    kind: 'edit',
    sideEffect: 'write',
    subjectKind: 'path',
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
    subject: (): Extract<PermissionSubject, { kind: 'path' }> => ({ kind: 'path', tool: 'Write', paths: [path.join(harness.layout.project, 'a.txt')], access: 'write' }),
    execute: async () => ({ status: 'completed' as const, output: 'ran' }),
  });
  const rule = ruleFor(harness.layout);
  const rules = (extra.rules ?? []).map(([kind, text]) => rule(kind as 'allow' | 'ask' | 'deny', text as string));
  const outcomes: CallOutcome[] = await harness.executor.runBatch(
    await harness.input(await toolSetOf(bash, write), [call('c1', tool, input)], {
      rules,
      ...(extra.mode === undefined ? {} : { mode: extra.mode }),
      ...(extra.mandate === undefined ? {} : { mandate: extra.mandate, hold: { blockers: [] } }),
      ...(extra.sandboxNetwork === undefined ? {} : { sandboxNetwork: extra.sandboxNetwork }),
    }),
  );
  const outcome = outcomes[0];
  expect(outcome?.kind).toBe('result');
  return (outcome as ResultOutcome).result.denial;
};

describe('the source of a refusal is the cause the decision names', () => {
  it('names the replacing operation as the source of a superseded form refused under a mandate', async () => {
    const denial = await denialOf({ command: 'git push origin main' }, { mandate: MANDATE, rules: [['allow', 'Bash(git:*)']] });
    expect(denial).toEqual({ source: 'superseded', reason: 'Not run: this run has a mandate, and git push is replaced by a dedicated operation; use GitPush' });
  });

  it('names the setting as the source of a network request refused by sandboxNetwork deny', async () => {
    const denial = await denialOf({ command: 'npm install', network: 'open' }, { mode: 'bypassPermissions', sandboxNetwork: 'deny' });
    expect(denial).toEqual({ source: 'setting', reason: 'the command requests unrestricted network access, and the setting sandboxNetwork is deny' });
  });

  it('names the mode as the source of a refusal of plan mode', async () => {
    const denial = await denialOf({ file_path: 'a.txt' }, { mode: 'plan' }, 'Write');
    expect(denial).toMatchObject({ source: 'mode', reason: expect.stringContaining('plan mode only allows read-only tools') });
  });

  it('names the mandate as the source of a call outside the mandate', async () => {
    const denial = await denialOf({ command: 'make build' }, { mandate: MANDATE });
    expect(denial).toMatchObject({ source: 'mandate', reason: expect.stringContaining('outside the declared mandate') });
  });

  it('names the rule as the source of a call a deny rule refuses', async () => {
    const denial = await denialOf({ command: 'make build' }, { rules: [['deny', 'Bash(make:*)']] });
    expect(denial).toMatchObject({ source: 'rule' });
  });
});
