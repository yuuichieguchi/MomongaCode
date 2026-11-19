import path from 'node:path';
import { DEFAULT_SANDBOX_NETWORK, EMPTY_FILE_RULES, describeNetworkScope, filterAsync, findAsync, isProtectedWrite, lexicallyWithin, networkScopeOfRequest, parseHostEntry, someAsync } from '@momonga/foundation';
import type { FileRuleSet, HostEntry, NetworkScope, ProtectedSet, SandboxNetworkSetting, SecretLocation, UnresolvableReason } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';
import type { ApprovalBasis, PermissionDenialSource, PermissionMode } from '@momonga/protocol';
import { commandApproval } from './approval.ts';
import { commandCoveredByAllowRules } from './command-match.ts';
import { createDecisionResolver } from './filesystem.ts';
import type { PolicyFilesystem, WritableCheck } from './filesystem.ts';
import { suggestAllowRule, suggestNetworkRule } from './suggest-allow-rule.ts';
import { supersededVerdictOf } from './superseded.ts';
import type { CoveredProgram, SupersededForm } from './superseded.ts';
import { isNetworkRule, matchPathlessStrength, matchRule, matchStrength, networkRuleCovers, ruleCoversSubject } from './match-rule.ts';
import type { PathlessSubject, RuleResolution } from './match-rule.ts';
import type { MatchStrength } from './command-match.ts';
import { absoluteFrom } from './path-match.ts';
import { commandSpecsFor } from './platform-specs.ts';
import { insideRoots } from './roots.ts';
import { analyzeCommand, executionSteps, looseRedirectTargets, unanalysedPartOf } from './shell.ts';
import type { Analysis } from './shell.ts';
import { changedBefore, judgedAfter, locateTargets, locateWrites, resolveSedPrograms, sedResolution } from './step-plan.ts';
import type { PathPlan } from './step-plan.ts';
import { describeReason, markRelativeUnresolvable, targetOfText } from './targets.ts';
import type { DecisionKind, PermissionSubject, PolicyTool } from './types.ts';
import { planModeRefuses } from './visible-tools.ts';

export type DecideInput = {
  tool: PolicyTool;
  subject: PermissionSubject;
  mode: PermissionMode;
  rules: PermissionRule[];
  roots: string[];
  readRoots?: readonly string[];
  secretLocations: readonly SecretLocation[];
  home: string;
  cwd: string;
  fileRules: FileRuleSet;
  protectedSet: ProtectedSet;
  fs: PolicyFilesystem;
  searchPath: string | undefined;
  isWritable: WritableCheck;
  sandboxNetwork?: SandboxNetworkSetting;
  mandate?: true;
  supersededForms?: readonly SupersededForm[];
  coveredPrograms?: readonly CoveredProgram[];
};

export type DenialCause = Extract<PermissionDenialSource, 'rule' | 'mode' | 'setting' | 'mandate' | 'superseded'>;

type DecisionFacts = {
  source: 'rule' | 'mode' | 'protected' | 'hook' | 'operation';
  reason: string;
  rule?: PermissionRule;
  humanOnly?: true;
  basis?: ApprovalBasis;
  network?: true;
};

export type Decision = (DecisionFacts & { kind: Exclude<DecisionKind, 'deny'> }) | (DecisionFacts & { kind: 'deny'; denial: DenialCause });

const WRITE_TOOL: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const READ_TOOL: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };

const HARMLESS_WRITE_TARGETS: ReadonlySet<string> = new Set(['/dev/null']);

const describeRule = (rule: PermissionRule): string => `${rule.text} (${rule.origin}: ${rule.source})`;

const basisOf = (kind: DecisionKind, basis: ApprovalBasis): { basis?: ApprovalBasis } => (kind === 'allow' ? { basis } : {});

const decided = (kind: DecisionKind, cause: DenialCause, facts: DecisionFacts): Decision => (kind === 'deny' ? { ...facts, kind, denial: cause } : { ...facts, kind });

const byRule = (kind: DecisionKind, rule: PermissionRule, verb: string): Decision =>
  decided(kind, 'rule', { source: 'rule', rule, reason: `${verb} by rule ${describeRule(rule)}`, ...basisOf(kind, 'rule') });

const byMode = (kind: DecisionKind, reason: string, basis: ApprovalBasis = 'mode'): Decision => decided(kind, 'mode', { source: 'mode', reason, ...basisOf(kind, basis) });

export const isGoverningRule = (rule: PermissionRule): boolean => rule.layer === 'governance';

const askByRule = (rule: PermissionRule, verb: string): Decision => ({ ...byRule('ask', rule, verb), ...(isGoverningRule(rule) ? { humanOnly: true as const } : {}) });

const isEmptySet = (set: ProtectedSet): boolean =>
  set.paths.length === 0 && set.lexicalPaths.length === 0 && set.literals.length === 0 && set.names.length === 0 && set.patterns.entries.length === 0;

const protectedWriteReason = async (input: DecideInput, subject: PermissionSubject): Promise<string | undefined> => {
  if (subject.kind !== 'path' || subject.access !== 'write' || isEmptySet(input.protectedSet)) return undefined;
  const probes = { canonicalise: input.fs.canonicalise, volumeProbe: input.fs.volumeProbe };
  for (const target of subject.paths) {
    const resolution = await input.fs.canonicalise(absoluteFrom(target, input.cwd));
    if (!resolution.ok) {
      return `writing to ${target} requires approval because its real location cannot be resolved (${describeReason(resolution.reason)}) and protected paths exist`;
    }
    if (await isProtectedWrite(input.protectedSet, resolution.path, probes)) return `writing to protected path ${resolution.path} requires approval`;
  }
  return undefined;
};

type Applicable = Array<{ rule: PermissionRule; ruleIndex: number }>;

type DenyInput = Pick<DecideInput, 'rules' | 'mode' | 'fileRules'> & { fs: { canonicalise: RuleResolution } };

const applicableRules = (input: Pick<DecideInput, 'rules'>, subject: PermissionSubject): Applicable =>
  input.rules.map((rule, ruleIndex) => ({ rule, ruleIndex })).filter(({ rule }) => ruleCoversSubject(rule, subject));

type DenyScan = { denied: Decision | undefined; incidental: PermissionRule | undefined; unanalysed: boolean };

type DenyHit = { rule: PermissionRule; strength: MatchStrength | null };

const scanDeny = async (input: DenyInput, subject: PermissionSubject, applicable: Applicable): Promise<DenyScan> => {
  const hits: DenyHit[] = [];
  for (const { rule, ruleIndex } of applicable) {
    if (rule.effect === 'deny') hits.push({ rule, strength: await matchStrength(rule, subject, input.fileRules, ruleIndex, input.fs.canonicalise) });
  }
  return strongestDeny(hits, input.mode);
};

const strongestDeny = (hits: readonly DenyHit[], mode: PermissionMode): DenyScan => {
  const position = hits.find((hit) => hit.strength === 'position');
  const incidentals = hits.filter((hit) => hit.strength === 'incidental');
  const incidental = incidentals.find((hit) => isGoverningRule(hit.rule)) ?? incidentals[0];
  const denied =
    position !== undefined
      ? byRule('deny', position.rule, 'denied')
      : incidental !== undefined && mode === 'bypassPermissions'
        ? byRule('deny', incidental.rule, 'denied')
        : undefined;
  return { denied, incidental: incidental?.rule, unanalysed: hits.some((hit) => hit.strength === 'unanalysable') };
};

export const denyingRuleFor = (rules: readonly PermissionRule[], mode: PermissionMode, subject: PathlessSubject): PermissionRule | undefined => {
  const hits = applicableRules({ rules: [...rules] }, subject)
    .filter(({ rule }) => rule.effect === 'deny')
    .map(({ rule }) => ({ rule, strength: matchPathlessStrength(rule, subject) }));
  return strongestDeny(hits, mode).denied?.rule;
};

type CommandSubject = Extract<PermissionSubject, { kind: 'command' }>;

const unanalysedReason = (subject: CommandSubject, restriction: string): string => {
  const part = unanalysedPartOf(subject.command);
  if (part === undefined) throw new Error('a command was matched as not analysable, and the analysis names no such part');
  return `a part of the command could not be analysed (${part}), and ${restriction} for ${subject.tool} exists, so no rule and no mode decides it`;
};

const unanalysedUnderDeny = (mode: PermissionMode, subject: CommandSubject): Decision => {
  const reason = unanalysedReason(subject, 'a deny rule');
  if (mode === 'bypassPermissions') return { kind: 'deny', denial: 'mode', source: 'mode', reason: `Not run: ${reason}, and bypassPermissions mode asks nobody` };
  return { kind: 'ask', source: 'mode', humanOnly: true, reason: `${reason}; a person decides` };
};

const unanalysedUnderAsk = (mode: PermissionMode, subject: CommandSubject, applicable: Applicable): Decision | undefined => {
  const unread = applicable.filter(({ rule }) => rule.effect === 'ask' && matchPathlessStrength(rule, subject) === 'unanalysable');
  if (unread.some(({ rule }) => isGoverningRule(rule))) return { kind: 'ask', source: 'mode', humanOnly: true, reason: `${unanalysedReason(subject, 'a governing ask rule')}; a person decides` };
  if (unread.length === 0 || mode === 'bypassPermissions') return undefined;
  return { kind: 'ask', source: 'mode', reason: `${unanalysedReason(subject, 'an ask rule')}; approval required` };
};

const operationDecision = (subject: PermissionSubject): Decision | undefined =>
  (subject.kind === 'repo' || subject.kind === 'forge') && subject.approval === 'always'
    ? { kind: 'ask', source: 'operation', humanOnly: true, reason: `${subject.operation} always needs a person to approve it, in every mode` }
    : undefined;

const protectedDecision = async (input: DecideInput, subject: PermissionSubject): Promise<Decision | undefined> => {
  const reason = await protectedWriteReason(input, subject);
  return reason === undefined ? undefined : { kind: 'ask', source: 'protected', reason, humanOnly: true };
};

const secretLocationOf = async (input: DecideInput, target: string): Promise<SecretLocation | undefined> => {
  const real = await input.fs.canonicalise(absoluteFrom(target, input.cwd));
  if (!real.ok) return undefined;
  return findAsync(input.secretLocations, async (location) => {
    const directory = await input.fs.canonicalise(location.directory);
    if (!directory.ok) return false;
    const fold = await input.fs.volumeProbe(directory.path);
    return fold ? lexicallyWithin(real.path.toLowerCase(), directory.path.toLowerCase()) : lexicallyWithin(real.path, directory.path);
  });
};

const secretDecision = async (input: DecideInput, subject: PermissionSubject): Promise<Decision | undefined> => {
  if (subject.kind !== 'path') return undefined;
  const madeReadable = subject.access === 'read' ? (input.readRoots ?? []) : [];
  for (const target of subject.paths) {
    const location = await secretLocationOf(input, target);
    if (location === undefined || (await insideRoots([target], madeReadable, input.cwd, input.fs))) continue;
    const place = absoluteFrom(target, input.cwd) === location.directory ? `it is ${location.label}` : `it is inside ${location.label}`;
    return { kind: 'deny', denial: 'mode', source: 'protected', reason: `${subject.access === 'read' ? 'reading' : 'writing to'} ${target} is denied in every permission mode: ${place}, a secret location` };
  }
  return undefined;
};

const writtenRuleDecides = async (input: DecideInput, subject: PermissionSubject, applicable: Applicable): Promise<boolean> =>
  someAsync(applicable, async ({ rule, ruleIndex }) => rule.effect !== 'deny' && (await matchRule(rule, subject, input.fileRules, ruleIndex, input.fs.canonicalise)));

const checkGuards = async (input: DecideInput, subject: PermissionSubject): Promise<Decision | undefined> => {
  const applicable = applicableRules(input, subject);
  const guarded = (await scanDeny(input, subject, applicable)).denied ?? (await protectedDecision(input, subject));
  if (guarded !== undefined || (await writtenRuleDecides(input, subject, applicable))) return guarded;
  return secretDecision(input, subject);
};

const modeDefault = async (input: DecideInput, subject: PermissionSubject): Promise<Decision> => {
  const { mode, roots, cwd } = input;
  if (subject.kind === 'governance') {
    return { ...byMode('ask', 'adding a governing fact needs a person to approve it in every mode, because it binds later sessions'), humanOnly: true };
  }
  if (mode === 'bypassPermissions') return byMode('allow', 'bypassPermissions mode allows everything not explicitly denied');
  switch (subject.kind) {
    case 'none':
    case 'agent':
      return byMode('allow', `${subject.tool} has no permission-relevant effect`);
    case 'mcp':
      return byMode('ask', `MCP tool mcp__${subject.server}__${subject.tool} requires approval`);
    case 'memory':
      return byMode('ask', `saving a ${subject.scope} memory requires approval because it persists into later sessions`);
    case 'history':
      return byMode('ask', `reading the recorded history of ${subject.project === 'all' ? 'every project' : subject.project} requires approval because it reaches outside this project`);
    case 'repo':
    case 'forge':
      return byMode('ask', `${subject.operation} requires approval`);
    case 'command':
      return commandDefault(input, subject.command);
    case 'path': {
      const inside = await insideRoots(subject.paths, roots, cwd, input.fs);
      if (subject.access === 'read') {
        if (inside) return byMode('allow', 'reads inside the workspace are allowed');
        if (await insideRoots(subject.paths, [...roots, ...(input.readRoots ?? [])], cwd, input.fs)) {
          return byMode('allow', 'reads inside an agent skill directory are allowed');
        }
        return byMode('ask', 'read outside the workspace requires approval');
      }
      if (mode === 'acceptEdits' && inside) return byMode('allow', 'acceptEdits mode allows edits inside the workspace');
      return byMode('ask', inside ? 'edits require approval' : 'edit outside the workspace requires approval');
    }
  }
};

const commandDefault = async (input: DecideInput, command: string): Promise<Decision> => {
  const approval = await commandApproval(input, command, analyzeCommand(command, commandSpecsFor(input.fs.platform)));
  if (approval === 'read-only') return byMode('allow', 'read-only command', 'read_only');
  if (approval === 'edit' && input.mode === 'acceptEdits') return byMode('allow', 'acceptEdits mode allows filesystem commands inside the workspace');
  return byMode('ask', 'shell commands require approval');
};

const decideSubject = async (input: DecideInput, tool: PolicyTool, subject: PermissionSubject, commandDerived: boolean): Promise<Decision> => {
  const { mode, fileRules } = input;
  const { canonicalise } = input.fs;
  const applicable = applicableRules(input, subject);
  const { denied, incidental, unanalysed } = await scanDeny(input, subject, applicable);
  if (denied !== undefined) return denied;

  if (subject.kind === 'governance') return modeDefault(input, subject);

  if (!commandDerived && mode === 'plan' && planModeRefuses(tool)) {
    return byMode('deny', `plan mode only allows read-only tools; ${tool.name} has side effect ${tool.sideEffect}`);
  }

  if (unanalysed && subject.kind === 'command') return unanalysedUnderDeny(mode, subject);

  const guarded = await protectedDecision(input, subject);
  if (guarded !== undefined) return guarded;

  const always = operationDecision(subject);
  if (always !== undefined) return always;

  const askRules = await filterAsync(applicable, async ({ rule, ruleIndex }) => rule.effect === 'ask' && (await matchRule(rule, subject, fileRules, ruleIndex, canonicalise)));
  const governingAsk = askRules.find(({ rule }) => isGoverningRule(rule));
  if (governingAsk !== undefined) return askByRule(governingAsk.rule, 'approval required');
  const unread = subject.kind === 'command' ? unanalysedUnderAsk(mode, subject, applicable) : undefined;
  if (unread?.humanOnly === true) return unread;
  const asked = askRules[0];
  if (asked !== undefined) {
    if (mode === 'bypassPermissions') return (await secretDecision(input, subject)) ?? byMode('allow', `bypassPermissions mode overrides ask rule ${describeRule(asked.rule)}`);
    return byRule('ask', asked.rule, 'approval required');
  }
  if (unread !== undefined) return unread;
  if (incidental !== undefined) return askByRule(incidental, 'approval required (the rule words appear as an argument)');

  const allowRules = applicable.filter(({ rule }) => rule.effect === 'allow');
  const allowed =
    subject.kind === 'command'
      ? commandCoveredByAllowRules(
          allowRules.map(({ rule }) => rule),
          subject.command,
        )
      : (await findAsync(allowRules, ({ rule, ruleIndex }) => matchRule(rule, subject, fileRules, ruleIndex, canonicalise)))?.rule;
  if (allowed !== undefined) return byRule('allow', allowed, 'allowed');

  return (await secretDecision(input, subject)) ?? modeDefault(input, subject);
};

const mergePlans = (plans: readonly PathPlan[]): PathPlan => ({
  paths: plans.flatMap((plan) => plan.paths),
  removes: plans.flatMap((plan) => plan.removes),
  candidates: plans.flatMap((plan) => plan.candidates),
  unresolvable: plans.flatMap((plan) => plan.unresolvable),
  needsApproval: plans.some((plan) => plan.needsApproval),
});

const analysisPlan = async (input: DecideInput, analysis: Analysis): Promise<{ writes: PathPlan; reads: PathPlan }> => {
  const steps = executionSteps(analysis, sedResolution(await resolveSedPrograms(input, analysis)));
  const plans = await locateWrites(input, steps);
  const writes: PathPlan[] = [];
  const reads: PathPlan[] = [];
  for (const [index, plan] of plans.entries()) {
    const changed = changedBefore(plans, index, 'name-creating').paths;
    reads.push(judgedAfter(await locateTargets(input, plan.step.reads), changed));
    writes.push(judgedAfter(plan.writes, changed));
  }
  return { writes: mergePlans(writes), reads: mergePlans(reads) };
};

const looseUnresolvable: UnresolvableReason = { kind: 'unanalyzable' };

const planPathAccess = async (input: DecideInput, command: string): Promise<{ writes: PathPlan; reads: PathPlan }> => {
  const analysis = analyzeCommand(command, commandSpecsFor(input.fs.platform));
  if (analysis !== null) return analysisPlan(input, analysis);
  const loose = await locateTargets(input, markRelativeUnresolvable(looseRedirectTargets(command).map((text) => targetOfText(text)), 'changed'));
  return {
    writes: { ...loose, paths: loose.paths.filter((target) => path.isAbsolute(target)), unresolvable: command.includes('>') ? [looseUnresolvable] : [] },
    reads: { ...(await locateTargets(input, [])), unresolvable: command.includes('<') ? [looseUnresolvable] : [] },
  };
};

const removesWorkspace = async (input: DecideInput, targets: readonly string[]): Promise<boolean> => {
  const roots: string[] = [];
  for (const root of input.roots) {
    const resolution = await input.fs.canonicalise(absoluteFrom(root, input.cwd));
    if (resolution.ok) roots.push(resolution.path);
  }
  return someAsync(targets, async (target) => {
    const resolution = await input.fs.canonicalise(target);
    return resolution.ok && roots.some((root) => lexicallyWithin(root, resolution.path));
  });
};

const decidePathAccess = async (input: DecideInput, plan: PathPlan, tool: PolicyTool, access: 'read' | 'write'): Promise<Decision[]> => {
  const decisions: Decision[] = [];
  if (input.mode !== 'bypassPermissions' && (await removesWorkspace(input, plan.removes))) decisions.push({ ...byMode('ask', 'the command removes the workspace'), humanOnly: true });
  if (plan.paths.length > 0) {
    decisions.push(await decideSubject(input, tool, { kind: 'path', tool: tool.name, paths: plan.paths, access }, true));
  }
  if (plan.candidates.length > 0) {
    const guard = await checkGuards(input, { kind: 'path', tool: tool.name, paths: plan.candidates, access });
    if (guard !== undefined) decisions.push(guard);
  }
  const governed = applicableRules(input, { kind: 'path', tool: tool.name, paths: [], access }).some(({ rule }) => isGoverningRule(rule));
  if (input.mode === 'bypassPermissions' && !governed) return decisions;
  const asked = (decision: Decision): Decision => (governed ? { ...decision, humanOnly: true } : decision);
  if (plan.unresolvable.length > 0) {
    const kinds = [...new Set(plan.unresolvable.map(describeReason))].join(', ');
    decisions.push(asked(byMode('ask', `the command accesses a path that cannot be determined statically (${kinds})`)));
  }
  if (plan.needsApproval) decisions.push(asked(byMode('ask', 'a redirect target starting with ~ requires approval')));
  return decisions;
};

const resolvingOnce = (input: DecideInput): DecideInput => ({ ...input, fs: createDecisionResolver(input.fs) });

const primaryOf = (input: DecideInput): Promise<Decision> => decideSubject(input, input.tool, input.subject, false);

export const decidePrimary = (input: DecideInput): Promise<Decision> => primaryOf(resolvingOnce(input));

const decideWithoutNetwork = async (input: DecideInput): Promise<Decision> => {
  const primary = await primaryOf(input);
  if (input.subject.kind !== 'command' || primary.kind === 'deny') return primary;

  const plan = await planPathAccess(input, input.subject.command);
  const writeDecisions = await decidePathAccess(input, plan.writes, WRITE_TOOL, 'write');
  const secondary = [...writeDecisions, ...(await decidePathAccess(input, plan.reads, READ_TOOL, 'read'))];
  const denied = secondary.find((decision) => decision.kind === 'deny');
  if (denied !== undefined) return denied;
  const humanOnly = secondary.find((decision) => decision.kind === 'ask' && decision.humanOnly === true);
  if (humanOnly?.source === 'protected') return humanOnly;
  if (primary.kind === 'ask' && primary.source !== 'mode') return primary;
  if (humanOnly !== undefined) return humanOnly;
  if (primary.kind === 'ask') return primary;
  return secondary.find((decision) => decision.kind === 'ask') ?? withWriteBasis(primary, plan.writes, writeDecisions);
};

const writesBeyondDevices = (writes: PathPlan): boolean => writes.paths.some((target) => !HARMLESS_WRITE_TARGETS.has(target));

const withWriteBasis = (primary: Decision, writes: PathPlan, writeDecisions: readonly Decision[]): Decision => {
  if (primary.basis !== 'read_only' || !writesBeyondDevices(writes)) return primary;
  const writing = writeDecisions.find((decision) => decision.kind === 'allow');
  if (writing?.basis === undefined) throw new Error('a command with write targets was allowed without an allowing write decision');
  return { ...primary, basis: writing.basis };
};

const PROXY_NOTE = 'through the sandbox proxy, which carries HTTP and HTTPS; a program that does not use the proxy variables stays without network';

const requestedEntries = (scope: Extract<NetworkScope, { kind: 'hosts' }>): HostEntry[] =>
  scope.hosts.map((text) => {
    const entry = parseHostEntry(text);
    if (entry === undefined) throw new Error(`the requested host ${text} was normalized without a host form`);
    return entry;
  });

const networkRulesOf = (input: DecideInput, effect: PermissionRule['effect']): PermissionRule[] => input.rules.filter((rule) => rule.effect === effect && isNetworkRule(rule));

const restrictingNetworkRule = (input: DecideInput, scope: NetworkScope, effect: 'deny' | 'ask'): PermissionRule | undefined => {
  const rules = networkRulesOf(input, effect);
  if (scope.kind === 'none') return undefined;
  if (scope.kind === 'open') return rules[0];
  const entries = requestedEntries(scope);
  return rules.find((rule) => entries.some((entry) => networkRuleCovers(rule, entry)));
};

const allowedByNetworkRules = (input: DecideInput, scope: NetworkScope): boolean => {
  const rules = networkRulesOf(input, 'allow');
  if (scope.kind === 'none') return true;
  if (scope.kind === 'open') return false;
  return requestedEntries(scope).every((entry) => rules.some((rule) => networkRuleCovers(rule, entry)));
};

const withNetworkRequest = (input: DecideInput, decision: Decision): Decision => {
  if (input.subject.kind !== 'command' || input.subject.network === undefined || decision.kind === 'deny') return decision;
  const scope = networkScopeOfRequest(input.subject.network);
  const requests = `the command requests ${describeNetworkScope(scope)}${scope.kind === 'hosts' ? ` (${PROXY_NOTE})` : ''}`;
  const denying = restrictingNetworkRule(input, scope, 'deny');
  if (denying !== undefined) {
    const denied = byRule('deny', denying, 'denied');
    return { ...denied, reason: `${requests}; ${denied.reason}`, network: true };
  }
  const setting = input.sandboxNetwork ?? DEFAULT_SANDBOX_NETWORK;
  if (setting === 'deny') return { kind: 'deny', denial: 'setting', source: 'mode', reason: `${requests}, and the setting sandboxNetwork is deny`, network: true };
  const asking = input.mode === 'bypassPermissions' ? undefined : restrictingNetworkRule(input, scope, 'ask');
  if (asking !== undefined) {
    const asked = askByRule(asking, 'approval required');
    return decision.kind === 'ask' ? { ...decision, reason: `${decision.reason}; ${requests}; ${asked.reason}`, network: true } : { ...asked, reason: `${requests}; ${asked.reason}`, network: true };
  }
  if (setting === 'allow' || input.mode === 'bypassPermissions' || allowedByNetworkRules(input, scope)) return decision.kind === 'ask' ? { ...decision, reason: `${decision.reason}; ${requests}` } : decision;
  if (decision.kind === 'ask') return { ...decision, reason: `${decision.reason}; ${requests}`, network: true };
  return { kind: 'ask', source: 'mode', reason: requests, network: true };
};

const programsOf = (forms: readonly SupersededForm[]): string => [...new Set(forms.map((form) => form.argv[0]))].join(', ');

const targetOf = (subject: PermissionSubject): string | undefined => {
  if (subject.kind === 'repo') {
    if (subject.remote === null) return undefined;
    const places = subject.destinations.length === 0 ? subject.remote : `${subject.remote} (${subject.destinations.join(', ')})`;
    return `${subject.refs.join(', ')} at ${places}`;
  }
  if (subject.kind === 'forge') {
    const pull = subject.pr === undefined ? '' : ` #${subject.pr}`;
    const head = subject.headSha === undefined ? '' : ` at commit ${subject.headSha}`;
    return `${subject.repo}${pull} on ${subject.host}${head}`;
  }
  return undefined;
};

const withTarget = (input: DecideInput, decision: Decision): Decision => {
  const target = decision.kind === 'ask' ? targetOf(input.subject) : undefined;
  return target === undefined ? decision : { ...decision, reason: `${decision.reason}; target: ${target}` };
};

const withinMandate = async (input: DecideInput, decision: Decision): Promise<Decision> => {
  if (input.mandate !== true || decision.kind !== 'ask' || decision.source !== 'mode' || decision.humanOnly === true) return decision;
  const rule = decision.network === true ? suggestNetworkRule(input.subject) : await suggestAllowRule(input.tool, input.subject, input.cwd, input.fs.canonicalise);
  const wayForward = rule === undefined ? '' : ` To allow it in a run under this mandate, add the rule ${rule} to the allow list of the mandate.`;
  return { kind: 'deny', denial: 'mandate', source: 'mode', reason: `Not run: outside the declared mandate (${decision.reason}).${wayForward} Continue with work inside it or report.` };
};

const onlyReads = async (input: DecideInput): Promise<boolean> => {
  const unruled = await decideWithoutNetwork({ ...input, rules: [], fileRules: EMPTY_FILE_RULES });
  return unruled.kind === 'allow' && unruled.basis === 'read_only';
};

export const decide = (given: DecideInput): Promise<Decision> => decideResolvingOnce(resolvingOnce(given));

const decideResolvingOnce = async (input: DecideInput): Promise<Decision> => {
  const ordinary = async (): Promise<Decision> => withTarget(input, await withinMandate(input, withNetworkRequest(input, await decideWithoutNetwork(input))));
  if (input.mandate !== true || input.subject.kind !== 'command' || input.supersededForms === undefined) return ordinary();
  const verdict = supersededVerdictOf(input.subject.command, input.supersededForms, commandSpecsFor(input.fs.platform), input.coveredPrograms);
  if (verdict === undefined) return ordinary();
  if (verdict.kind === 'superseded') {
    return {
      kind: 'deny',
      denial: 'superseded',
      source: 'mode',
      reason:
        verdict.form.refusal === undefined
          ? `Not run: this run has a mandate, and ${verdict.form.argv.join(' ')} is replaced by a dedicated operation; use ${verdict.form.operation}`
          : `Not run: this run has a mandate, and ${verdict.form.argv.join(' ')} ${verdict.form.refusal.word} is refused: ${verdict.form.refusal.reason}`,
    };
  }
  const decided = withNetworkRequest(input, await decideWithoutNetwork(input));
  if (decided.kind === 'deny') return decided;
  if (await onlyReads(input)) return ordinary();
  return {
    kind: 'ask',
    source: 'operation',
    humanOnly: true,
    reason: `this run has a mandate, and the command could be a form that a dedicated operation replaces (${programsOf(input.supersededForms)}): the whole command is not one that is known to only read, so a person decides`,
    ...(decided.network === true ? { network: true as const } : {}),
  };
};
