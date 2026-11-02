import type { PermissionRule } from '@momonga/policy';
import type { Bool } from 'z3-solver';
import { SUBJECT_TOOLS, ruleEffectCases } from './decision-model.ts';
import type { RuleTerms, SubjectModel, SubjectTool } from './decision-model.ts';
import { outcomeFor, probe, termsOf } from './queries.ts';
import type { Probe, QueryContext } from './queries.ts';
import { describeWitness } from './report.ts';
import type { Counterexample, Finding, PropertyResult, Verdict } from './report.ts';

export type SecretLocation = { label: string; directory: string; accesses: readonly ('read' | 'write')[] };

const READ_SUBJECTS: readonly SubjectTool[] = ['Read', 'Glob', 'Grep'];
const WRITE_SUBJECTS: readonly SubjectTool[] = ['Write'];

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
    doesNotProve: ['inputs outside the modelled input domain', 'that a deny rule describes everything its author meant to forbid'],
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
      if (rule.effect === 'allow') tally.unknowns.push(`${ruleLabel(rule)} uses a word or a program outside the modelled command alphabet, so whether it can take effect was not decided`);
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
    proves: 'removing any single rule on a modelled tool changes the decision for at least one modelled input, and no allow rule lies entirely inside a deny rule',
    doesNotProve: ['that the rules that remain express the intent of their author', 'effects on inputs outside the modelled input domain'],
    verdict: verdictOf(tally),
  };
};

export const checkBashAdmission = async (context: QueryContext): Promise<PropertyResult> => {
  const { models } = context;
  const ctx = models.smt.ctx;
  const tally = newTally();
  const bash = termsOf(context, 'Bash');
  const allows = bash.filter((term) => term.rule.effect === 'allow' && term.rule.specifier !== undefined);
  const denies = bash.filter((term) => term.rule.effect === 'deny' && term.rule.specifier !== undefined);
  const command = subjectOf(context, 'Bash').commandTerm as NonNullable<SubjectModel['commandTerm']>;
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
      'for every Bash allow rule and every Bash deny rule of two or more words, no plain command is allowed that has the denied words in order with only option words between them',
    doesNotProve: [
      'that the option words skipped here are the only ones that can separate a program from its subcommand',
      'commands that reach a denied program through a wrapper, a shell payload or a script',
    ],
    verdict: verdictOf(tally),
  };
};
