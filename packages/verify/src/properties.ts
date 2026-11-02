import type { PermissionRule } from '@momonga/policy';
import type { Bool } from 'z3-solver';
import { SUBJECT_TOOLS, ruleEffectCases } from './decision-model.ts';
import type { RuleTerms, SubjectModel, SubjectTool } from './decision-model.ts';
import { outcomeFor, probe, termsOf } from './queries.ts';
import type { Probe, QueryContext } from './queries.ts';
import { describeWitness } from './report.ts';
import { commandDecisionWithout } from './replay.ts';
import type { Counterexample, Finding, PropertyResult, Verdict } from './report.ts';

export type SecretLocation = { label: string; directory: string; accesses: readonly ('read' | 'write')[] };

const READ_SUBJECTS: readonly SubjectTool[] = ['Read', 'Glob', 'Grep'];
const WRITE_SUBJECTS: readonly SubjectTool[] = ['Write'];

const READ_ONLY_CALL = 'a command approved as read-only runs with no writable path except the per-spawn scratch directory and a fixed git environment';

const READ_ONLY_LIMITS = {
  denyPrecedence: `a read-only approval: deny rules are decided before the mode default, so the proof does not depend on the analysis that approves a command as read-only; it also does not model that ${READ_ONLY_CALL}`,
  secretReach: 'a read-only approval: the kernel sandbox of such a call does not stop reads, so a command the analysis approves as read-only can still read a location outside the rules; this proof gets nothing from that sandbox',
  ruleConsistency: `a read-only approval: the proof does not model that ${READ_ONLY_CALL}; the sandbox never makes a rule redundant, because a rule is judged by its effect on the decision only`,
  bashAdmission: `a read-only approval: the model leaves the mode default of a Bash command an open yes or no, so the proof holds whatever the analysis approves as read-only and does not rely on the fact that ${READ_ONLY_CALL}`,
} as const;

const ruleLabel = (rule: PermissionRule): string => `${rule.text} (${rule.origin}: ${rule.source})`;

type Tally = { findings: Finding[]; notes: string[]; unknowns: string[] };

const newTally = (): Tally => ({ findings: [], notes: [], unknowns: [] });

const absorb = (tally: Tally, result: Probe, onFound: (counterexample: Counterexample) => Finding): void => {
  if (result.status === 'found') tally.findings.push(onFound(result.counterexample));
  else if (result.status === 'unknown') tally.unknowns.push(result.reason);
};

const verdictOf = (tally: Tally): Verdict => {
  if (tally.findings.length > 0) return { status: 'refuted', findings: tally.findings, notes: [...tally.notes, ...tally.unknowns.map((reason) => `a query was undecided: ${reason}`)] };
  if (tally.unknowns.length > 0) return { status: 'unknown', reason: [...new Set(tally.unknowns)].join('; '), notes: tally.notes };
  return { status: 'proved', notes: tally.notes };
};

const anyOf = (context: QueryContext, terms: readonly Bool[]): Bool => {
  const ctx = context.models.smt.ctx;
  return terms.length === 0 ? ctx.Bool.val(false) : terms.length === 1 ? (terms[0] as Bool) : ctx.Or(...terms);
};

const toolsOf = (context: QueryContext, rule: PermissionRule, index: number): SubjectTool[] =>
  SUBJECT_TOOLS.filter((tool) => termsOf(context, tool).some((term) => term.index === index && term.rule === rule));

const termOf = (context: QueryContext, tool: SubjectTool, index: number): RuleTerms => termsOf(context, tool).find((term) => term.index === index) as RuleTerms;

const subjectOf = (context: QueryContext, tool: SubjectTool): SubjectModel => context.subjects.get(tool) as SubjectModel;

export const checkDenyPrecedence = async (context: QueryContext): Promise<PropertyResult> => {
  const { models } = context;
  const ctx = models.smt.ctx;
  const tally = newTally();
  for (const [index, rule] of models.rules.entries()) {
    if (rule.effect !== 'allow') continue;
    for (const tool of toolsOf(context, rule, index)) {
      const denies = termsOf(context, tool).filter((term) => term.rule.effect === 'deny');
      if (denies.length === 0) continue;
      const allowTerm = termOf(context, tool, index);
      const denyHit = anyOf(context, denies.flatMap((term) => [term.position, term.incidental]));
      const escape = await probe(context, 'deny-precedence', `${rule.text} against the deny rules (${tool})`, tool, [allowTerm.strict, denyHit, outcomeFor(context, tool).allow]);
      absorb(tally, escape, (counterexample) => ({
        subject: ruleLabel(rule),
        message: `${describeWitness(counterexample.witness)} is allowed although a deny rule matches it`,
        counterexample,
      }));
      if (escape.status !== 'none') continue;
      for (const deny of denies) {
        const overlap = await probe(context, 'deny-precedence', `${rule.text} overlapping ${deny.rule.text} (${tool})`, tool, [allowTerm.strict, ctx.Or(deny.position, deny.incidental)]);
        if (overlap.status === 'found') {
          tally.notes.push(`${ruleLabel(rule)} overlaps ${ruleLabel(deny.rule)}, for example at ${describeWitness(overlap.counterexample.witness)}; the outcome there is ${overlap.counterexample.predicted}`);
        } else if (overlap.status === 'unknown') {
          tally.unknowns.push(overlap.reason);
        }
      }
    }
  }
  return {
    id: 'deny-precedence',
    title: 'an allow rule does not get around a deny rule',
    subject: `${models.rules.filter((rule) => rule.effect === 'allow').length} allow rule(s) against ${models.rules.filter((rule) => rule.effect === 'deny').length} deny rule(s)`,
    proves: 'for every allow rule and every tool it covers, no modelled input is allowed while a deny rule covering that tool matches it',
    doesNotProve: ['inputs outside the modelled input domain', 'that a deny rule describes everything its author meant to forbid', READ_ONLY_LIMITS.denyPrecedence],
    verdict: verdictOf(tally),
  };
};

const locationAccessSubjects = (access: 'read' | 'write'): readonly SubjectTool[] => (access === 'read' ? READ_SUBJECTS : WRITE_SUBJECTS);

export const checkSecretReach = async (context: QueryContext, locations: readonly SecretLocation[]): Promise<PropertyResult> => {
  const { models } = context;
  const tally = newTally();
  const regions: Array<{ label: string; access: 'read' | 'write'; region: (resolved: NonNullable<ReturnType<typeof subjectOf>['resolvedTerm']>) => Bool }> = [];
  for (const location of locations) {
    const canonical = models.paths.canonicalDirectory(location.directory);
    if (!canonical.ok) {
      tally.unknowns.push(`${location.label} cannot be resolved to its real location (${canonical.reason.kind === 'errno' ? canonical.reason.code : canonical.reason.kind})`);
      continue;
    }
    for (const access of location.accesses) regions.push({ label: `${location.label} (${access})`, access, region: (resolved) => models.paths.under(resolved, canonical.path) });
  }
  regions.push({ label: 'the protected set of the workspace (write)', access: 'write', region: (resolved) => models.paths.protectedWrite(resolved) });
  for (const { label, access, region } of regions) {
    for (const tool of locationAccessSubjects(access)) {
      const resolved = subjectOf(context, tool).resolvedTerm;
      if (resolved === undefined) continue;
      const reached = await probe(context, 'secret-reach', `${label} through ${tool}`, tool, [region(resolved), outcomeFor(context, tool).allow]);
      absorb(tally, reached, (counterexample) => ({
        subject: label,
        message: `${describeWitness(counterexample.witness)} is reachable without approval: ${counterexample.cause}`,
        counterexample,
      }));
    }
  }
  return {
    id: 'secret-reach',
    title: 'the rules leave no route to secrets',
    subject: `${regions.length} secret location(s) and access kind(s)`,
    proves: 'for each listed location and access, no modelled path inside it is allowed without approval by any allow rule or by the mode default',
    doesNotProve: [
      'access through programs that read or write a secret location on their own, such as a shell command that expands a variable',
      'secret locations that are not in the list above',
      READ_ONLY_LIMITS.secretReach,
    ],
    verdict: verdictOf(tally),
  };
};

export const checkRuleConsistency = async (context: QueryContext): Promise<PropertyResult> => {
  const { models } = context;
  const ctx = models.smt.ctx;
  const tally = newTally();
  for (const [index, rule] of models.rules.entries()) {
    const tools = toolsOf(context, rule, index);
    if (tools.length === 0) continue;
    if (rule.tool === 'Bash' && models.commands.unmodelled(rule)) {
      if (models.commands.wrapperDeny(rule)) {
        const candidates = models.commands.candidates(rule);
        const effective = candidates.some((candidate) => commandDecisionWithout(context.env, candidate, undefined) !== commandDecisionWithout(context.env, candidate, rule));
        if (!effective) tally.unknowns.push(`${ruleLabel(rule)} is a deny rule for a wrapper, shell or eval program; none of the commands tried (${candidates.join(' | ')}) shows it changing a decision, and other commands through the wrapper are not modelled`);
      } else {
        tally.unknowns.push(`${ruleLabel(rule)} ${rule.effect === 'deny' ? 'uses a word outside the modelled command alphabet' : rule.effect === 'ask' ? 'is an ask rule that the model cannot follow (a deny rule can reach the command through the wrapper or the word is outside the modelled alphabet)' : 'is an allow rule that the model cannot follow (a word outside the modelled alphabet, or a wrapper, shell or eval program)'}, so whether it can take effect was not decided`);
      }
      continue;
    }
    let effective = false;
    let undecided: string | undefined;
    let example: Counterexample | undefined;
    for (const tool of tools) {
      const term = termOf(context, tool, index);
      for (const effectCase of ruleEffectCases(models, subjectOf(context, tool), term)) {
        const change = await probe(context, 'rule-consistency', `${rule.text} (${tool})`, tool, [effectCase]);
        if (change.status === 'found') effective = true;
        else if (change.status === 'unknown') undecided = change.reason;
        if (effective) break;
      }
      if (effective) break;
      if (example === undefined) {
        const reach = await probe(context, 'rule-consistency', `${rule.text} reach (${tool})`, tool, [ctx.Or(term.position, term.incidental, term.strict)], new Set([index]));
        if (reach.status === 'found') example = reach.counterexample;
        else if (reach.status === 'unknown') undecided = reach.reason;
      }
    }
    if (effective) continue;
    if (undecided !== undefined) {
      tally.unknowns.push(undecided);
      continue;
    }
    tally.findings.push({
      subject: ruleLabel(rule),
      message:
        example === undefined
          ? 'this rule matches no input of the modelled domain, so it can never take effect'
          : `this rule can never take effect: for every input it matches the decision is the same without it; for example ${describeWitness(example.witness)} is ${example.predicted} regardless (${example.cause})`,
      ...(example === undefined ? {} : { counterexample: example }),
    });
  }
  const allows = [...models.rules.entries()].filter(([, rule]) => rule.effect === 'allow');
  const denies = [...models.rules.entries()].filter(([, rule]) => rule.effect === 'deny');
  for (const [allowIndex, allow] of allows) {
    for (const [denyIndex, deny] of denies) {
      for (const tool of toolsOf(context, allow, allowIndex).filter((candidate) => termsOf(context, candidate).some((term) => term.index === denyIndex))) {
        const allowTerm = termOf(context, tool, allowIndex);
        const denyTerm = termOf(context, tool, denyIndex);
        const reach = await probe(context, 'rule-consistency', `${allow.text} reach (${tool})`, tool, [allowTerm.strict]);
        if (reach.status === 'unknown') tally.unknowns.push(reach.reason);
        if (reach.status !== 'found') continue;
        const outside = await probe(context, 'rule-consistency', `${allow.text} outside ${deny.text} (${tool})`, tool, [allowTerm.strict, ctx.Not(denyTerm.position), ctx.Not(denyTerm.incidental)]);
        if (outside.status === 'none') {
          tally.findings.push({
            subject: `${ruleLabel(allow)} and ${ruleLabel(deny)}`,
            message: `every input the allow rule matches is also matched by the deny rule, so the allow rule contradicts the deny rule and has no effect (${tool})`,
          });
        } else if (outside.status === 'unknown') {
          tally.unknowns.push(outside.reason);
        }
      }
    }
  }
  return {
    id: 'rule-consistency',
    title: 'every rule can take effect and no pair of rules contradicts',
    subject: `${models.rules.length} rule(s)`,
    proves: 'removing any single rule on a modelled tool changes the decision for at least one modelled input, and no allow rule lies entirely inside a deny rule; a Bash deny rule for a wrapper, shell or eval program is shown effective on concrete commands only, and any other Bash rule outside the modelled command alphabet makes the result unknown instead',
    doesNotProve: ['that the rules that remain express the intent of their author', 'effects on inputs outside the modelled input domain', READ_ONLY_LIMITS.ruleConsistency],
    verdict: verdictOf(tally),
  };
};

export const checkBashAdmission = async (context: QueryContext): Promise<PropertyResult> => {
  const { models } = context;
  const ctx = models.smt.ctx;
  const tally = newTally();
  const bash = termsOf(context, 'Bash');
  const allows = bash.filter((term) => term.rule.effect === 'allow');
  const denies = bash.filter((term) => term.rule.effect === 'deny' && term.rule.specifier !== undefined);
  const command = subjectOf(context, 'Bash').commandTerm as NonNullable<SubjectModel['commandTerm']>;
  const bashRules = models.rules.filter((rule) => rule.tool === 'Bash' && rule.specifier !== undefined);
  const hasDeny = bashRules.some((rule) => rule.effect === 'deny');
  for (const rule of bashRules) {
    if (!models.commands.unmodelled(rule)) continue;
    const singleWordWrapperDeny = models.commands.wrapperDeny(rule) && models.commands.wordCount(rule) === 1;
    const matters = rule.effect === 'allow' ? hasDeny : allows.length > 0 && !singleWordWrapperDeny;
    if (matters) tally.unknowns.push(`${ruleLabel(rule)} is outside what the model can follow, so whether ${rule.effect === 'allow' ? 'it admits a denied command' : 'an allow rule gets around it'} was not decided`);
  }
  for (const allow of allows) {
    for (const deny of denies) {
      const admits = await probe(context, 'bash-admission', `${allow.rule.text} admitting ${deny.rule.text}`, 'Bash', [allow.strict, ctx.Or(deny.position, deny.incidental)]);
      if (admits.status === 'found') {
        tally.notes.push(`${ruleLabel(allow.rule)} admits commands that ${ruleLabel(deny.rule)} names, for example ${describeWitness(admits.counterexample.witness)}; the outcome there is ${admits.counterexample.predicted}`);
      } else if (admits.status === 'unknown') {
        tally.unknowns.push(admits.reason);
      }
      const escape = await probe(context, 'bash-admission', `${allow.rule.text} against ${deny.rule.text}`, 'Bash', [
        allow.strict,
        models.commands.broad(command, deny.rule),
        outcomeFor(context, 'Bash').allow,
      ]);
      absorb(tally, escape, (counterexample) => ({
        subject: `${ruleLabel(allow.rule)} and ${ruleLabel(deny.rule)}`,
        message: `${describeWitness(counterexample.witness)} names the program and subcommand that the deny rule forbids, with option words between them, and is allowed because the deny rule matches only adjacent words`,
        counterexample,
      }));
    }
  }
  return {
    id: 'bash-admission',
    title: 'a Bash allow rule does not admit a denied program or subcommand',
    subject: `${allows.length} Bash allow rule(s) against ${denies.length} Bash deny rule(s)`,
    proves:
      'for every Bash allow rule and every Bash deny rule of two or more words that the model can follow, no plain command is allowed that has the denied words in order with only option words between them; a Bash allow rule outside the modelled command alphabet, a deny or ask rule outside it, and a deny rule of several words for a wrapper, shell or eval program make the result unknown instead',
    doesNotProve: [
      'that the option words skipped here are the only ones that can separate a program from its subcommand',
      'commands that reach a denied program through a wrapper, a shell payload or a script',
      READ_ONLY_LIMITS.bashAdmission,
    ],
    verdict: verdictOf(tally),
  };
};
