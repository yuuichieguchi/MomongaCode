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
import { resolveSegmentProgram } from './program-resolution.ts';
import { discoverRepository } from './repository.ts';
import { insideRoots } from './roots.ts';
import { allReadTargets, allWriteTargets, analyzeCommand, looseRedirectTargets, programNameOf } from './shell.ts';
import type { Analysis, Segment } from './shell.ts';
import { describeReason, markRelativeUnresolvable, targetOfText } from './targets.ts';
import type { Target } from './targets.ts';
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
};

const DISCARD_TARGETS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
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
  return reason === undefined ? undefined : { kind: 'ask', source: 'protected', reason };
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
  const approval = commandApproval(input, command, analyzeCommand(command));
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

type PathPlan = {
  paths: string[];
  removes: string[];
  candidates: string[];
  unresolvable: UnresolvableReason[];
  needsApproval: boolean;
};

const worktreeOf = (input: DecideInput): string => {
  const discovery = discoverRepository(input.cwd, input.fs);
  if ('found' in discovery && discovery.found && discovery.hit.entry === 'dotgit') return discovery.hit.directory;
  const cwd = input.fs.canonicalise(input.cwd);
  const canonicalCwd = cwd.ok ? cwd.path : input.cwd;
  for (const root of input.roots) {
    const resolution = input.fs.canonicalise(absoluteFrom(root, input.cwd));
    if (resolution.ok && lexicallyWithin(canonicalCwd, resolution.path)) return resolution.path;
  }
  return canonicalCwd;
};

const resolveTargets = (input: DecideInput, targets: readonly Target[]): PathPlan => {
  const plan: PathPlan = { paths: [], removes: [], candidates: [], unresolvable: [], needsApproval: false };
  const resolve = (text: string): string | undefined => {
    if (DISCARD_TARGETS.has(text)) return undefined;
    if (text === '~' || text.startsWith('~/')) return path.join(input.home, text.slice(1));
    return absoluteFrom(text, input.cwd);
  };
  let worktree: string | undefined;
  for (const target of targets) {
    if ('unresolvable' in target) {
      plan.unresolvable.push(target.unresolvable);
    } else if ('worktree' in target) {
      worktree ??= worktreeOf(input);
      const resolved = target.below === undefined ? worktree : path.join(worktree, target.below);
      plan.paths.push(resolved);
      plan.removes.push(resolved);
    } else if ('candidate' in target) {
      const resolved = resolve(target.candidate);
      if (resolved === undefined) continue;
      plan.candidates.push(resolved);
      if (target.removes === true) plan.removes.push(resolved);
    } else {
      const resolved = resolve(target.literal);
      if (resolved === undefined) continue;
      plan.paths.push(resolved);
      if (target.removes === true) plan.removes.push(resolved);
      if (target.needsApproval === true) plan.needsApproval = true;
    }
  }
  return plan;
};

const sedResolution =
  (input: DecideInput) =>
  (segment: Segment): string | undefined => {
    if (programNameOf(segment) !== 'sed') return undefined;
    const resolution = resolveSegmentProgram(segment, input);
    return 'program' in resolution ? resolution.program : undefined;
  };

const analysisPlan = (input: DecideInput, analysis: Analysis): { writes: PathPlan; reads: PathPlan } => ({
  writes: resolveTargets(input, allWriteTargets(analysis, sedResolution(input))),
  reads: resolveTargets(input, allReadTargets(analysis)),
});

const looseUnresolvable: UnresolvableReason = { kind: 'unanalyzable' };

const planPathAccess = (input: DecideInput, command: string): { writes: PathPlan; reads: PathPlan } => {
  const analysis = analyzeCommand(command);
  if (analysis !== null) return analysisPlan(input, analysis);
  const loose = resolveTargets(input, markRelativeUnresolvable(looseRedirectTargets(command).map((text) => targetOfText(text)), 'changed'));
  return {
    writes: { ...loose, paths: loose.paths.filter((target) => path.isAbsolute(target)), unresolvable: command.includes('>') ? [looseUnresolvable] : [] },
    reads: { ...resolveTargets(input, []), unresolvable: command.includes('<') ? [looseUnresolvable] : [] },
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
  if (input.mode !== 'bypassPermissions' && removesWorkspace(input, plan.removes)) decisions.push(byMode('ask', 'the command removes the workspace'));
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
  const guarded = secondary.find((decision) => decision.kind === 'ask' && decision.source === 'protected');
  if (guarded !== undefined) return guarded;
  if (primary.kind === 'ask') return primary;
  return secondary.find((decision) => decision.kind === 'ask') ?? primary;
};
