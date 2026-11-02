import path from 'node:path';
import { isProtectedWrite, lexicallyWithin } from '@momonga/foundation';
import type { FileRuleSet, ProtectedSet, UnresolvableReason } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';
import type { PermissionMode } from '@momonga/protocol';
import { commandApproval } from './approval.ts';
import { commandCoveredByAllowRules } from './command-match.ts';
import type { PolicyFilesystem } from './filesystem.ts';
import { matchRule, matchStrength, ruleCoversSubject } from './match-rule.ts';
import { absoluteFrom } from './path-match.ts';
import { commandSpecsFor } from './platform-specs.ts';
import { insideRoots } from './roots.ts';
import { analyzeCommand, executionSteps, looseRedirectTargets } from './shell.ts';
import type { Analysis } from './shell.ts';
import { changedBefore, judgedAfter, locateTargets, locateWrites, sedResolution } from './step-plan.ts';
import type { PathPlan } from './step-plan.ts';
import { describeReason, markRelativeUnresolvable, targetOfText } from './targets.ts';
import type { DecisionKind, PermissionSubject, PolicyTool } from './types.ts';

export type DecideInput = {
  tool: PolicyTool;
  subject: PermissionSubject;
  mode: PermissionMode;
  rules: PermissionRule[];
  roots: string[];
  readRoots?: readonly string[];
  home: string;
  cwd: string;
  fileRules: FileRuleSet;
  protectedSet: ProtectedSet;
  fs: PolicyFilesystem;
  searchPath: string | undefined;
  isWritable: (absolute: string) => boolean;
};

export type Decision = {
  kind: DecisionKind;
  source: 'rule' | 'mode' | 'protected' | 'hook';
  reason: string;
  rule?: PermissionRule;
  humanOnly?: true;
};

const WRITE_TOOL: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write' };
const READ_TOOL: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };

const describeRule = (rule: PermissionRule): string => `${rule.text} (${rule.origin}: ${rule.source})`;

const byRule = (kind: DecisionKind, rule: PermissionRule, verb: string): Decision => ({
  kind,
  source: 'rule',
  rule,
  reason: `${verb} by rule ${describeRule(rule)}`,
});

const byMode = (kind: DecisionKind, reason: string): Decision => ({ kind, source: 'mode', reason });

const isEmptySet = (set: ProtectedSet): boolean =>
  set.paths.length === 0 && set.lexicalPaths.length === 0 && set.literals.length === 0 && set.names.length === 0 && set.patterns.entries.length === 0;

const protectedWriteReason = (input: DecideInput, subject: PermissionSubject): string | undefined => {
  if (subject.kind !== 'path' || subject.access !== 'write' || isEmptySet(input.protectedSet)) return undefined;
  const probes = { canonicalise: input.fs.canonicalise, volumeProbe: input.fs.volumeProbe };
  for (const target of subject.paths) {
    const resolution = input.fs.canonicalise(absoluteFrom(target, input.cwd));
    if (!resolution.ok) {
      return `writing to ${target} requires approval because its real location cannot be resolved (${describeReason(resolution.reason)}) and protected paths exist`;
    }
    if (isProtectedWrite(input.protectedSet, resolution.path, probes)) return `writing to protected path ${resolution.path} requires approval`;
  }
  return undefined;
};

type Applicable = Array<{ rule: PermissionRule; ruleIndex: number }>;

const applicableRules = (input: DecideInput, subject: PermissionSubject): Applicable =>
  input.rules.map((rule, ruleIndex) => ({ rule, ruleIndex })).filter(({ rule }) => ruleCoversSubject(rule, subject));

type DenyScan = { denied: Decision | undefined; incidental: PermissionRule | undefined };

const scanDeny = (input: DecideInput, subject: PermissionSubject, applicable: Applicable): DenyScan => {
  const hits = applicable
    .filter(({ rule }) => rule.effect === 'deny')
    .map(({ rule, ruleIndex }) => ({ rule, strength: matchStrength(rule, subject, input.fileRules, ruleIndex) }));
  const position = hits.find((hit) => hit.strength === 'position');
  const incidental = hits.find((hit) => hit.strength === 'incidental');
  const denied =
    position !== undefined
      ? byRule('deny', position.rule, 'denied')
      : incidental !== undefined && input.mode === 'bypassPermissions'
        ? byRule('deny', incidental.rule, 'denied')
        : undefined;
  return { denied, incidental: incidental?.rule };
};

const protectedDecision = (input: DecideInput, subject: PermissionSubject): Decision | undefined => {
  const reason = protectedWriteReason(input, subject);
  return reason === undefined ? undefined : { kind: 'ask', source: 'protected', reason, humanOnly: true };
};

const checkGuards = (input: DecideInput, subject: PermissionSubject): Decision | undefined =>
  scanDeny(input, subject, applicableRules(input, subject)).denied ?? protectedDecision(input, subject);

const modeDefault = (input: DecideInput, subject: PermissionSubject): Decision => {
  const { mode, roots, cwd } = input;
  if (mode === 'bypassPermissions') return byMode('allow', 'bypassPermissions mode allows everything not explicitly denied');
  switch (subject.kind) {
    case 'none':
      return byMode('allow', `${subject.tool} has no permission-relevant effect`);
    case 'mcp':
      return byMode('ask', `MCP tool mcp__${subject.server}__${subject.tool} requires approval`);
    case 'memory':
      return byMode('ask', `saving a ${subject.scope} memory requires approval because it persists into later sessions`);
    case 'command':
      return commandDefault(input, subject.command);
    case 'path': {
      const inside = insideRoots(subject.paths, roots, cwd, input.fs.canonicalise);
      if (subject.access === 'read') {
        if (inside) return byMode('allow', 'reads inside the workspace are allowed');
        if (insideRoots(subject.paths, [...roots, ...(input.readRoots ?? [])], cwd, input.fs.canonicalise)) {
          return byMode('allow', 'reads inside an agent skill directory are allowed');
        }
        return byMode('ask', 'read outside the workspace requires approval');
      }
      if (mode === 'acceptEdits' && inside) return byMode('allow', 'acceptEdits mode allows edits inside the workspace');
      return byMode('ask', inside ? 'edits require approval' : 'edit outside the workspace requires approval');
    }
  }
};

const commandDefault = (input: DecideInput, command: string): Decision => {
  const approval = commandApproval(input, command, analyzeCommand(command, commandSpecsFor(input.fs.platform)));
  if (approval === 'read-only') return byMode('allow', 'read-only command');
  if (approval === 'edit' && input.mode === 'acceptEdits') return byMode('allow', 'acceptEdits mode allows filesystem commands inside the workspace');
  return byMode('ask', 'shell commands require approval');
};

const decideSubject = (input: DecideInput, tool: PolicyTool, subject: PermissionSubject, commandDerived: boolean): Decision => {
  const { mode, fileRules } = input;
  const applicable = applicableRules(input, subject);
  const { denied, incidental } = scanDeny(input, subject, applicable);
  if (denied !== undefined) return denied;

  if (!commandDerived && mode === 'plan' && tool.sideEffect !== 'read_only' && subject.kind !== 'command') {
    return byMode('deny', `plan mode only allows read-only tools; ${tool.name} has side effect ${tool.sideEffect}`);
  }

  const guarded = protectedDecision(input, subject);
  if (guarded !== undefined) return guarded;

  const asked = applicable.find(({ rule, ruleIndex }) => rule.effect === 'ask' && matchRule(rule, subject, fileRules, ruleIndex));
  if (asked !== undefined) {
    if (mode === 'bypassPermissions') return byMode('allow', `bypassPermissions mode overrides ask rule ${describeRule(asked.rule)}`);
    return byRule('ask', asked.rule, 'approval required');
  }
  if (incidental !== undefined) return byRule('ask', incidental, 'approval required (the rule words appear as an argument)');

  const allowRules = applicable.filter(({ rule }) => rule.effect === 'allow');
  const allowed =
    subject.kind === 'command'
      ? commandCoveredByAllowRules(
          allowRules.map(({ rule }) => rule),
          subject.command,
        )
      : allowRules.find(({ rule, ruleIndex }) => matchRule(rule, subject, fileRules, ruleIndex))?.rule;
  if (allowed !== undefined) return byRule('allow', allowed, 'allowed');

  return modeDefault(input, subject);
};

const mergePlans = (plans: readonly PathPlan[]): PathPlan => ({
  paths: plans.flatMap((plan) => plan.paths),
  removes: plans.flatMap((plan) => plan.removes),
  candidates: plans.flatMap((plan) => plan.candidates),
  unresolvable: plans.flatMap((plan) => plan.unresolvable),
  needsApproval: plans.some((plan) => plan.needsApproval),
});

const analysisPlan = (input: DecideInput, analysis: Analysis): { writes: PathPlan; reads: PathPlan } => {
  const steps = executionSteps(analysis, sedResolution(input));
  const plans = locateWrites(input, steps);
  const writes: PathPlan[] = [];
  const reads: PathPlan[] = [];
  for (const [index, plan] of plans.entries()) {
    const changed = changedBefore(plans, index, 'name-creating').paths;
    reads.push(judgedAfter(locateTargets(input, plan.step.reads), changed));
    writes.push(judgedAfter(plan.writes, changed));
  }
  return { writes: mergePlans(writes), reads: mergePlans(reads) };
};

const looseUnresolvable: UnresolvableReason = { kind: 'unanalyzable' };

const planPathAccess = (input: DecideInput, command: string): { writes: PathPlan; reads: PathPlan } => {
  const analysis = analyzeCommand(command, commandSpecsFor(input.fs.platform));
  if (analysis !== null) return analysisPlan(input, analysis);
  const loose = locateTargets(input, markRelativeUnresolvable(looseRedirectTargets(command).map((text) => targetOfText(text)), 'changed'));
  return {
    writes: { ...loose, paths: loose.paths.filter((target) => path.isAbsolute(target)), unresolvable: command.includes('>') ? [looseUnresolvable] : [] },
    reads: { ...locateTargets(input, []), unresolvable: command.includes('<') ? [looseUnresolvable] : [] },
  };
};

const removesWorkspace = (input: DecideInput, targets: readonly string[]): boolean => {
  const roots: string[] = [];
  for (const root of input.roots) {
    const resolution = input.fs.canonicalise(absoluteFrom(root, input.cwd));
    if (resolution.ok) roots.push(resolution.path);
  }
  return targets.some((target) => {
    const resolution = input.fs.canonicalise(target);
    return resolution.ok && roots.some((root) => lexicallyWithin(root, resolution.path));
  });
};

const decidePathAccess = (input: DecideInput, plan: PathPlan, tool: PolicyTool, access: 'read' | 'write'): Decision[] => {
  const decisions: Decision[] = [];
  if (input.mode !== 'bypassPermissions' && removesWorkspace(input, plan.removes)) decisions.push({ ...byMode('ask', 'the command removes the workspace'), humanOnly: true });
  if (plan.paths.length > 0) {
    decisions.push(decideSubject(input, tool, { kind: 'path', tool: tool.name, paths: plan.paths, access }, true));
  }
  if (plan.candidates.length > 0) {
    const guard = checkGuards(input, { kind: 'path', tool: tool.name, paths: plan.candidates, access });
    if (guard !== undefined) decisions.push(guard);
  }
  if (input.mode === 'bypassPermissions') return decisions;
  if (plan.unresolvable.length > 0) {
    const kinds = [...new Set(plan.unresolvable.map(describeReason))].join(', ');
    decisions.push(byMode('ask', `the command accesses a path that cannot be determined statically (${kinds})`));
  }
  if (plan.needsApproval) decisions.push(byMode('ask', 'a redirect target starting with ~ requires approval'));
  return decisions;
};

export const decidePrimary = (input: DecideInput): Decision => decideSubject(input, input.tool, input.subject, false);

export const decide = (input: DecideInput): Decision => {
  const primary = decidePrimary(input);
  if (input.subject.kind !== 'command' || primary.kind === 'deny') return primary;

  const plan = planPathAccess(input, input.subject.command);
  const secondary = [
    ...decidePathAccess(input, plan.writes, WRITE_TOOL, 'write'),
    ...decidePathAccess(input, plan.reads, READ_TOOL, 'read'),
  ];
  const denied = secondary.find((decision) => decision.kind === 'deny');
  if (denied !== undefined) return denied;
  const humanOnly = secondary.find((decision) => decision.kind === 'ask' && decision.humanOnly === true);
  if (humanOnly?.source === 'protected') return humanOnly;
  if (primary.kind === 'ask' && primary.source !== 'mode') return primary;
  if (humanOnly !== undefined) return humanOnly;
  if (primary.kind === 'ask') return primary;
  return secondary.find((decision) => decision.kind === 'ask') ?? primary;
};
