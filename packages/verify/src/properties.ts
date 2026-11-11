import { someAsync } from '@momonga/foundation';
import { matchPathlessRule, supersededFormOf } from '@momonga/policy';
import type { PermissionRule, SupersededForm } from '@momonga/policy';
import type { RuleNote, RuleNoteRule } from '@momonga/protocol';
import type { Bool } from 'z3-solver';
import { ASKING_MODES, SUBJECT_TOOLS, ruleEffectCases } from './decision-model.ts';
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

type Tally = { findings: Finding[]; byModeDefault: Finding[]; notes: string[]; unknowns: string[] };

const newTally = (): Tally => ({ findings: [], byModeDefault: [], notes: [], unknowns: [] });

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
    byModeDefault: tally.byModeDefault,
  };
};

const locationAccessSubjects = (access: 'read' | 'write'): readonly SubjectTool[] => (access === 'read' ? READ_SUBJECTS : WRITE_SUBJECTS);

export const checkSecretReach = async (context: QueryContext, locations: readonly SecretLocation[]): Promise<PropertyResult> => {
  const { models } = context;
  const tally = newTally();
  const regions: Array<{ label: string; access: 'read' | 'write'; region: (resolved: NonNullable<ReturnType<typeof subjectOf>['resolvedTerm']>) => Bool | Promise<Bool> }> = [];
  for (const location of locations) {
    const canonical = await models.paths.canonicalDirectory(location.directory);
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
      const outcome = outcomeFor(context, tool);
      const opened = await probe(context, 'secret-reach', `${label} through ${tool}`, tool, [await region(resolved), outcome.allow, outcome.allowedByRule]);
      absorb(tally, opened, (counterexample) => ({
        subject: label,
        message: `${describeWitness(counterexample.witness)} is reachable without approval: ${counterexample.cause}`,
        counterexample,
      }));
      if (opened.status !== 'none') continue;
      const reached = await probe(context, 'secret-reach', `${label} through ${tool} by the mode default`, tool, [await region(resolved), outcome.allow]);
      if (reached.status === 'unknown') tally.unknowns.push(reached.reason);
      if (reached.status !== 'found') continue;
      tally.byModeDefault.push({
        subject: label,
        message: `${describeWitness(reached.counterexample.witness)} is reachable without approval by the mode default: ${reached.counterexample.cause}`,
        counterexample: reached.counterexample,
      });
    }
  }
  return {
    id: 'secret-reach',
    title: 'the rules leave no route to secrets',
    subject: `${regions.length} secret location(s) and access kind(s)`,
    proves: 'for each listed location and access, no modelled path inside it is allowed without approval by an allow rule; a path that the chosen mode allows with no allow rule is listed as by the mode default, which is the stated consequence of that mode and does not refute the rules',
    doesNotProve: [
      'access through programs that read or write a secret location on their own, such as a shell command that expands a variable',
      'secret locations that are not in the list above',
      READ_ONLY_LIMITS.secretReach,
    ],
    verdict: verdictOf(tally),
    byModeDefault: tally.byModeDefault,
  };
};

const RULES_ALONE_MODE = 'manual';

const noteRuleOf = (rule: PermissionRule): RuleNoteRule => ({ text: rule.text, origin: rule.origin, source: rule.source });

const noteOf = (kind: RuleNote['kind'], rules: readonly PermissionRule[], message: string, modes: readonly string[] = []): RuleNote => ({ kind, rules: rules.map(noteRuleOf), modes: [...modes], message });

const undecidedNote = (rule: PermissionRule, reason: string): RuleNote => noteOf('undecided', [rule], `whether ${ruleLabel(rule)} can take effect was not decided: ${reason}`);

const DECIDED_BEFORE: Readonly<Record<PermissionRule['effect'], readonly PermissionRule['effect'][]>> = { deny: ['deny'], ask: ['deny', 'ask'], allow: ['deny', 'ask', 'allow'] };

const matchOf = (context: QueryContext, term: RuleTerms): Bool => (term.rule.effect === 'allow' ? term.strict : context.models.smt.ctx.Or(term.position, term.incidental));

const sameWriting = (left: PermissionRule, right: PermissionRule): boolean =>
  left.effect === right.effect && left.text === right.text && left.settingsRoot === right.settingsRoot && left.home === right.home && left.cwd === right.cwd;

type Decided<T> = { decided: true; value: T } | { decided: false; reason: string };

const coverOf = async (context: QueryContext, rule: PermissionRule, index: number, tools: readonly SubjectTool[]): Promise<Decided<PermissionRule | undefined>> => {
  const ctx = context.models.smt.ctx;
  for (const [otherIndex, other] of context.models.rules.entries()) {
    if (otherIndex === index || !DECIDED_BEFORE[rule.effect].includes(other.effect)) continue;
    if (!tools.every((tool) => termsOf(context, tool).some((term) => term.index === otherIndex))) continue;
    let covers = true;
    for (const tool of tools) {
      const outside = await probe(context, 'rule-consistency', `${rule.text} outside ${other.text} (${tool})`, tool, [matchOf(context, termOf(context, tool, index)), ctx.Not(matchOf(context, termOf(context, tool, otherIndex)))]);
      if (outside.status === 'unknown') return { decided: false, reason: outside.reason };
      if (outside.status === 'found') {
        covers = false;
        break;
      }
    }
    if (covers) return { decided: true, value: other };
  }
  return { decided: true, value: undefined };
};

const impliedModes = async (context: QueryContext, rule: PermissionRule, index: number, tools: readonly SubjectTool[]): Promise<Decided<readonly string[]>> => {
  const ctx = context.models.smt.ctx;
  let modes: readonly string[] = ASKING_MODES;
  for (const tool of tools) {
    const subject = subjectOf(context, tool);
    const { cases } = ruleEffectCases(context.models, subject, termOf(context, tool, index));
    const impliedHere: string[] = [];
    for (const modeDefault of subject.askingModeDefaults) {
      const needed = await probe(context, 'rule-consistency', `${rule.text} beyond the default of ${modeDefault.modes.join(', ')} (${tool})`, tool, [anyOf(context, cases), ctx.Not(modeDefault.allow)]);
      if (needed.status === 'unknown') return { decided: false, reason: needed.reason };
      if (needed.status === 'none') impliedHere.push(...modeDefault.modes);
    }
    modes = modes.filter((mode) => impliedHere.includes(mode));
  }
  return { decided: true, value: modes };
};

const noteForUnmodelled = async (context: QueryContext, rule: PermissionRule): Promise<RuleNote | undefined> => {
  const { commands } = context.models;
  if (!commands.wrapperDeny(rule)) {
    const why =
      rule.effect === 'deny'
        ? 'it uses a word outside the modelled command alphabet'
        : rule.effect === 'ask'
          ? 'it is an ask rule that the model cannot follow (a deny rule can reach the command through the wrapper or the word is outside the modelled alphabet)'
          : 'it is an allow rule that the model cannot follow (a word outside the modelled alphabet, or a wrapper, shell or eval program)';
    return undecidedNote(rule, why);
  }
  const rulesAlone = { ...context.env, mode: RULES_ALONE_MODE } as const;
  const candidates = commands.candidates(rule);
  const effective = await someAsync(candidates, async (candidate) => (await commandDecisionWithout(rulesAlone, candidate, undefined)) !== (await commandDecisionWithout(rulesAlone, candidate, rule)));
  return effective
    ? undefined
    : undecidedNote(rule, `it is a deny rule for a wrapper, shell or eval program; none of the commands tried (${candidates.join(' | ')}) shows it changing a decision, and other commands through the wrapper are not modelled`);
};

const noteForRule = async (context: QueryContext, rule: PermissionRule, index: number): Promise<RuleNote | undefined> => {
  const { models } = context;
  const tools = toolsOf(context, rule, index);
  if (tools.length === 0) return undefined;
  if (rule.tool === 'Bash' && models.commands.unmodelled(rule)) return noteForUnmodelled(context, rule);
  for (const tool of tools) {
    const effect = ruleEffectCases(models, subjectOf(context, tool), termOf(context, tool, index));
    const change = await probe(context, 'rule-consistency', `${rule.text} (${tool})`, tool, [anyOf(context, effect.cases)]);
    if (change.status === 'unknown') return undecidedNote(rule, change.reason);
    if (change.status === 'none') continue;
    if (!effect.unlessDefaultAllows) return undefined;
    const implied = await impliedModes(context, rule, index, tools);
    if (!implied.decided) return undecidedNote(rule, implied.reason);
    return implied.value.length === 0
      ? undefined
      : noteOf('implied-by-mode', [rule], `${ruleLabel(rule)} changes no decision in ${implied.value.join(', ')} mode: the mode already allows everything the rule allows`, implied.value);
  }
  for (const tool of tools) {
    const reach = await probe(context, 'rule-consistency', `${rule.text} reach (${tool})`, tool, [matchOf(context, termOf(context, tool, index))]);
    if (reach.status === 'unknown') return undecidedNote(rule, reach.reason);
    if (reach.status === 'none') continue;
    const twins = [...models.rules.entries()].filter(([otherIndex, other]) => otherIndex !== index && sameWriting(rule, other));
    if (twins.length > 0) {
      if (twins.some(([otherIndex]) => otherIndex < index)) return undefined;
      const group = [rule, ...twins.map(([, other]) => other)];
      return noteOf('duplicate', group, `${group.map(ruleLabel).join(' and ')} are one rule written ${group.length} times; one is enough`);
    }
    const cover = await coverOf(context, rule, index, tools);
    if (!cover.decided) return undecidedNote(rule, cover.reason);
    if (cover.value === undefined) return noteOf('no-effect', [rule], `${ruleLabel(rule)} changes no decision: for every input it matches the other rules decide the same without it`);
    const order = cover.value.effect === rule.effect ? '' : `, and ${cover.value.effect} is decided before ${rule.effect}`;
    return noteOf('no-effect', [rule, cover.value], `${ruleLabel(rule)} changes no decision: ${ruleLabel(cover.value)} matches every input it matches${order}`);
  }
  return noteOf('never-matches', [rule], `${ruleLabel(rule)} matches no input, so it can never take effect`);
};

export const checkRuleConsistency = async (context: QueryContext): Promise<PropertyResult> => {
  const { models } = context;
  const ruleNotes: RuleNote[] = [];
  for (const [index, rule] of models.rules.entries()) {
    const note = await noteForRule(context, rule, index);
    if (note !== undefined) ruleNotes.push(note);
  }
  return {
    id: 'rule-consistency',
    title: 'notes on rules that change no decision',
    subject: `${models.rules.length} rule(s)`,
    proves:
      'nothing is refused by this check: a rule gets a note when removing it changes the decision for no modelled input (it matches nothing, another rule covers it, it is written twice, or a mode already allows what it allows); the notes are computed from the rules alone and are the same in every mode; a Bash deny rule for a wrapper, shell or eval program is tried on concrete commands only, and any other Bash rule outside the modelled command alphabet gets a note that it was not decided',
    doesNotProve: ['that the rules that remain express the intent of their author', 'effects on inputs outside the modelled input domain', READ_ONLY_LIMITS.ruleConsistency],
    verdict: ruleNotes.length === 0 ? { status: 'proved', notes: [] } : { status: 'noted', ruleNotes, notes: ruleNotes.map((note) => note.message) },
    byModeDefault: [],
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
    byModeDefault: tally.byModeDefault,
  };
};

const COMMAND_PREFIX = ':*';

const candidatesFor = (rule: PermissionRule, form: SupersededForm): string[] => {
  const plain = form.argv.join(' ');
  if (rule.specifier === undefined) return [plain];
  const specifier = rule.specifier.endsWith(COMMAND_PREFIX) ? rule.specifier.slice(0, -COMMAND_PREFIX.length) : rule.specifier;
  const words = specifier.trim().split(/\s+/);
  const narrower = form.argv.every((word, index) => words[index] === word);
  return narrower ? [plain, specifier.trim()] : [plain];
};

export const checkSupersededForms = (context: QueryContext, forms: readonly SupersededForm[]): PropertyResult => {
  const tally = newTally();
  const allows = context.models.rules.filter((rule) => rule.tool === 'Bash' && rule.effect === 'allow');
  for (const rule of allows) {
    for (const form of forms) {
      const admitted = candidatesFor(rule, form).find((command) => {
        if (supersededFormOf(command, [form]) === undefined) return false;
        return matchPathlessRule(rule, { kind: 'command', tool: 'Bash', command });
      });
      if (admitted === undefined) continue;
      tally.findings.push({
        subject: ruleLabel(rule),
        message: `duplicate prevention not guaranteed: this allow rule admits \`${admitted}\`, which ${form.operation} replaces; a run that uses Bash for it is not reconciled against the real state`,
      });
    }
  }
  return {
    id: 'superseded-forms',
    title: 'no allow rule admits a Bash form that a dedicated operation replaces',
    subject: `${allows.length} Bash allow rule(s) against ${forms.length} superseded form(s)`,
    proves: 'for every Bash allow rule and every superseded form, the rule does not admit the bare form or the form completed with the words of the rule itself, judged by the same matcher the decision uses',
    doesNotProve: [
      'commands that reach the form through a wrapper, a shell payload or a script, or with arguments that differ from the rule words',
      'that the dedicated operation is registered and visible to the model',
      'the mode default of a command, because only rules are examined',
    ],
    verdict: verdictOf(tally),
    byModeDefault: tally.byModeDefault,
  };
};

export const checkMandateHolds = (context: QueryContext, alwaysOperations: readonly string[]): PropertyResult => {
  const tally = newTally();
  const allows = context.models.rules.filter((rule) => rule.effect === 'allow' && alwaysOperations.includes(rule.tool));
  for (const rule of allows) {
    tally.findings.push({
      subject: ruleLabel(rule),
      message: `this allow rule names ${rule.tool}, which always needs a person: the rule does not lower it, and the call is held until a person approves`,
    });
  }
  return {
    id: 'mandate-holds',
    title: 'no allow rule names an operation that always needs a person',
    subject: `${context.models.rules.filter((rule) => rule.effect === 'allow').length} allow rule(s) against ${alwaysOperations.length} operation(s) of the class always`,
    proves: 'no allow rule is written for an operation whose approval class is always, so no rule reads as if it let such an operation run without a person',
    doesNotProve: ['an approval class the user changed under operations.approval in the user settings', 'a push that becomes always by its arguments (force, delete) or by a protected ref'],
    verdict: verdictOf(tally),
    byModeDefault: tally.byModeDefault,
  };
};
