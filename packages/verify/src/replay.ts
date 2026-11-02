import { EMPTY_GLOB_TABLE, createGlobDeadline, decide, decidePrimary, prepareGlobs, settleGlobs } from '@momonga/policy';
import type { DecideInput, DecisionKind, PermissionRule, PermissionSubject, PolicyHostFilesystem, PolicyTool } from '@momonga/policy';
import type { FileRuleSet, ProtectedSet } from '@momonga/foundation';
import type { PermissionMode } from '@momonga/protocol';
import type { SubjectTool, Witness } from './decision-model.ts';
import type { Replay } from './report.ts';

export type ReplayEnvironment = {
  rules: readonly PermissionRule[];
  roots: readonly string[];
  mode: PermissionMode;
  home: string;
  cwd: string;
  fileRules: FileRuleSet;
  protectedSet: ProtectedSet;
  fs: PolicyHostFilesystem;
  globBudgetMs: number;
};

export type Prediction = { kind: DecisionKind; dependsOnDefault: boolean; viaPaths: boolean };

const TOOLS: Readonly<Record<Exclude<SubjectTool, 'mcp'>, PolicyTool>> = {
  Read: { name: 'Read', kind: 'read', sideEffect: 'read_only' },
  Glob: { name: 'Glob', kind: 'search', sideEffect: 'read_only' },
  Grep: { name: 'Grep', kind: 'search', sideEffect: 'read_only' },
  Write: { name: 'Write', kind: 'edit', sideEffect: 'write' },
  Bash: { name: 'Bash', kind: 'execute', sideEffect: 'exec' },
};

const inputFor = (env: ReplayEnvironment, tool: SubjectTool, witness: Witness): Omit<DecideInput, 'fs'> => {
  const base = {
    mode: env.mode,
    rules: [...env.rules],
    roots: [...env.roots],
    home: env.home,
    cwd: env.cwd,
    fileRules: env.fileRules,
    protectedSet: env.protectedSet,
    searchPath: undefined,
    isWritable: (): boolean => false,
  };
  switch (witness.kind) {
    case 'path': {
      const subject: PermissionSubject = { kind: 'path', tool: witness.tool, paths: [witness.requested], access: witness.access };
      return { ...base, tool: TOOLS[tool as Exclude<SubjectTool, 'mcp'>], subject };
    }
    case 'command': {
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: witness.command };
      return { ...base, tool: TOOLS.Bash, subject };
    }
    case 'mcp': {
      const subject: PermissionSubject = { kind: 'mcp', server: witness.server, tool: witness.tool };
      return { ...base, tool: { name: `mcp__${witness.server}__${witness.tool}`, kind: 'other', sideEffect: witness.readOnly ? 'read_only' : 'write' }, subject };
    }
  }
};

export const commandDecisionWithout = (env: ReplayEnvironment, command: string, omitted: PermissionRule | undefined): DecisionKind => {
  const rules = env.rules.filter((rule) => rule !== omitted);
  return decidePrimary({ ...inputFor({ ...env, rules }, 'Bash', { kind: 'command', command, defaultAllow: false }), fs: settleGlobs(env.fs, EMPTY_GLOB_TABLE) }).kind;
};

export const replayWitness = async (env: ReplayEnvironment, tool: SubjectTool, witness: Witness, predicted: Prediction): Promise<Replay> => {
  let actual: DecisionKind;
  let final: DecisionKind;
  try {
    const unsettled = inputFor(env, tool, witness);
    const globs = await prepareGlobs({
      expand: env.fs.expandGlob,
      platform: env.fs.platform,
      subject: unsettled.subject,
      cwd: env.cwd,
      home: env.home,
      deadline: createGlobDeadline(env.globBudgetMs),
      signal: new AbortController().signal,
    });
    const input: DecideInput = { ...unsettled, fs: settleGlobs(env.fs, globs) };
    actual = decidePrimary(input).kind;
    final = decide(input).kind;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { crashed: `${error.name}: ${error.message}` };
  }
  if (predicted.dependsOnDefault && witness.kind === 'command') return { skipped: 'the outcome depends on the approval class of the command, which the model leaves open' };
  const compared = predicted.viaPaths ? final : actual;
  return compared === predicted.kind ? { agrees: true, actual: compared, final } : { agrees: false, predicted: predicted.kind, actual: compared, final };
};
