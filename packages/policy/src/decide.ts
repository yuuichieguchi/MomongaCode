import path from 'node:path';
import { comparableContains, containsByComponents, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';
import type { PermissionMode } from '@momonga/protocol';
import { commandCoveredByAllowRules } from './command-match.ts';
import { matchRule, matchStrength, ruleCoversToolName } from './match-rule.ts';
import { absoluteFrom, canonicalizePath } from './path-match.ts';
import { allReads, allRedirects, analyzeCommand, changesDirectory, looseRedirectTargets } from './shell.ts';
import type { RedirectTarget } from './shell.ts';
import type { DecisionKind, PermissionSubject, PolicyTool } from './types.ts';

export type DecideInput = {
  tool: PolicyTool;
  subject: PermissionSubject;
  mode: PermissionMode;
  rules: PermissionRule[];
  roots: string[];
  home: string;
  cwd: string;
  protectedPaths?: readonly string[];
};

export type Decision = {
  kind: DecisionKind;
  source: 'rule' | 'mode' | 'protected';
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

type Guard = { guard: string; resolved: string | null; lexical: string };

const componentsOfPath = (value: string): string[] => value.split('/').filter((component) => component !== '');

const guardCovers = ({ resolved, lexical }: Guard, canonical: string): boolean =>
  resolved === null
    ? containsByComponents(
        { existing: '/', tail: componentsOfPath(lexical) },
        { existing: '/', tail: componentsOfPath(canonical) },
        volumeIsCaseInsensitive(lexical),
      )
    : comparableContains(resolved, canonical);

const protectedWriteReason = (input: DecideInput, subject: PermissionSubject): string | undefined => {
  if (subject.kind !== 'path' || subject.access !== 'write') return undefined;
  const protectedPaths = input.protectedPaths ?? [];
  if (protectedPaths.length === 0) return undefined;
  const guards: Guard[] = protectedPaths.map((guard) => ({
    guard,
    resolved: canonicalizePath(absoluteFrom(guard, input.cwd)),
    lexical: path.resolve(input.cwd, guard),
  }));
  for (const target of subject.paths) {
    const canonical = canonicalizePath(absoluteFrom(target, input.cwd));
    if (canonical === null) return `writing to ${target} requires approval because its real location cannot be resolved and protected paths exist`;
    const hit = guards.find((guard) => guardCovers(guard, canonical));
    if (hit !== undefined) return `writing to protected path ${hit.guard} requires approval`;
  }
  return undefined;
};

const insideRoots = (paths: readonly string[], roots: string[], cwd: string): boolean => {
  if (paths.length === 0) return false;
  const canonicalRoots = roots.map((root) => canonicalizePath(absoluteFrom(root, cwd))).filter((root): root is string => root !== null);
  return paths.every((target) => {
    const real = canonicalizePath(absoluteFrom(target, cwd));
    return real !== null && canonicalRoots.some((root) => comparableContains(root, real));
  });
};

const modeDefault = (input: DecideInput, subject: PermissionSubject): Decision => {
  const { mode, roots, cwd } = input;
  if (mode === 'bypassPermissions') return byMode('allow', 'bypassPermissions mode allows everything not explicitly denied');
  switch (subject.kind) {
    case 'none':
      return byMode('allow', `${subject.tool} has no permission-relevant effect`);
    case 'mcp':
      return byMode('ask', `MCP tool mcp__${subject.server}__${subject.tool} requires approval`);
    case 'command':
      return byMode('ask', 'shell commands require approval');
    case 'path': {
      const inside = insideRoots(subject.paths, roots, cwd);
      if (subject.access === 'read') {
        return inside ? byMode('allow', 'reads inside the workspace are allowed') : byMode('ask', 'read outside the workspace requires approval');
      }
      if (mode === 'acceptEdits' && inside) return byMode('allow', 'acceptEdits mode allows edits inside the workspace');
      return byMode('ask', inside ? 'edits require approval' : 'edit outside the workspace requires approval');
    }
  }
};

const decideSubject = (input: DecideInput, tool: PolicyTool, subject: PermissionSubject): Decision => {
  const { rules, mode } = input;
  const applicable = rules.filter((rule) => ruleCoversToolName(rule, subject.kind === 'mcp' ? `mcp__${subject.server}__${subject.tool}` : subject.tool));

  const denyHits = applicable
    .filter((rule) => rule.effect === 'deny')
    .map((rule) => ({ rule, strength: matchStrength(rule, subject, input.roots) }));
  const denied = denyHits.find((hit) => hit.strength === 'position');
  if (denied !== undefined) return byRule('deny', denied.rule, 'denied');
  const incidental = denyHits.find((hit) => hit.strength === 'incidental');
  if (incidental !== undefined && mode === 'bypassPermissions') return byRule('deny', incidental.rule, 'denied');

  if (mode === 'plan' && tool.sideEffect !== 'read_only') {
    return byMode('deny', `plan mode only allows read-only tools; ${tool.name} has side effect ${tool.sideEffect}`);
  }

  const guardReason = protectedWriteReason(input, subject);
  if (guardReason !== undefined) return { kind: 'ask', source: 'protected', reason: guardReason };

  const asked = applicable.find((rule) => rule.effect === 'ask' && matchRule(rule, subject, input.roots));
  if (asked !== undefined) {
    if (mode === 'bypassPermissions') return byMode('allow', `bypassPermissions mode overrides ask rule ${describeRule(asked)}`);
    return byRule('ask', asked, 'approval required');
  }
  if (incidental !== undefined) return byRule('ask', incidental.rule, 'approval required (the rule words appear as an argument)');

  const allowRules = applicable.filter((rule) => rule.effect === 'allow');
  const allowed =
    subject.kind === 'command'
      ? commandCoveredByAllowRules(allowRules, subject.command)
      : allowRules.find((rule) => matchRule(rule, subject, input.roots));
  if (allowed !== undefined) return byRule('allow', allowed, 'allowed');

  return modeDefault(input, subject);
};

type PathPlan = { paths: string[]; unresolvable: boolean };

const resolveTargets = (input: DecideInput, targets: RedirectTarget[], relativeUnsafe: boolean): PathPlan => {
  const paths: string[] = [];
  let unresolvable = false;
  for (const target of targets) {
    if (target === null) {
      unresolvable = true;
    } else if (DISCARD_TARGETS.has(target)) {
      continue;
    } else if (target === '~' || target.startsWith('~/')) {
      paths.push(path.join(input.home, target.slice(1)));
    } else if (target.startsWith('~')) {
      unresolvable = true;
    } else if (path.isAbsolute(target)) {
      paths.push(target);
    } else if (relativeUnsafe) {
      unresolvable = true;
    } else {
      paths.push(absoluteFrom(target, input.cwd));
    }
  }
  return { paths, unresolvable };
};

const planPathAccess = (input: DecideInput, command: string): { writes: PathPlan; reads: PathPlan } => {
  const analysis = analyzeCommand(command);
  if (analysis === null) {
    const writes = resolveTargets(input, looseRedirectTargets(command), true);
    return {
      writes: { paths: writes.paths.filter((target) => path.isAbsolute(target)), unresolvable: command.includes('>') || writes.unresolvable },
      reads: { paths: [], unresolvable: command.includes('<') },
    };
  }
  const relativeUnsafe = changesDirectory(analysis);
  return {
    writes: resolveTargets(input, allRedirects(analysis), relativeUnsafe),
    reads: resolveTargets(input, allReads(analysis), relativeUnsafe),
  };
};

const decidePathAccess = (input: DecideInput, plan: PathPlan, tool: PolicyTool, access: 'read' | 'write'): Decision[] => {
  const decisions: Decision[] = [];
  if (plan.paths.length > 0) {
    decisions.push(decideSubject(input, tool, { kind: 'path', tool: tool.name, paths: plan.paths, access }));
  }
  if (plan.unresolvable) {
    const denying = input.rules.find((rule) => rule.effect === 'deny' && ruleCoversToolName(rule, tool.name));
    if (denying === undefined) {
      if (input.mode !== 'bypassPermissions') decisions.push(byMode('ask', 'the command accesses a path that cannot be determined statically'));
    } else if (access === 'write' || input.mode === 'bypassPermissions') {
      decisions.push(byRule('deny', denying, 'denied (a path argument cannot be determined statically)'));
    } else {
      decisions.push(byRule('ask', denying, 'approval required (a read target cannot be determined statically and Read deny rules exist)'));
    }
  }
  return decisions;
};

export const decide = (input: DecideInput): Decision => {
  if (input.mode === 'auto') throw new Error('auto mode is not available yet');
  const primary = decideSubject(input, input.tool, input.subject);
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
