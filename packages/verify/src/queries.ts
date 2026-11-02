import type { DecisionKind } from '@momonga/policy';
import type { SolveBudget } from './budget.ts';
import type { Bool } from 'z3-solver';
import { SUBJECT_TOOLS, createSubject, outcomeOf } from './decision-model.ts';
import type { DecisionModels, Outcome, RuleTerms, SubjectModel, SubjectTool, Witness } from './decision-model.ts';
import type { SolveResult } from './smt.ts';
import { isMismatch } from './report.ts';
import type { Counterexample, ModelMismatch, PropertyId } from './report.ts';
import { replayWitness } from './replay.ts';
import type { Prediction, ReplayEnvironment } from './replay.ts';

export type QueryContext = {
  models: DecisionModels;
  env: ReplayEnvironment;
  budget: SolveBudget;
  subjects: ReadonlyMap<SubjectTool, SubjectModel>;
  mismatches: ModelMismatch[];
};

export type Probe =
  | { status: 'found'; counterexample: Counterexample }
  | { status: 'none' }
  | { status: 'unknown'; reason: string };

export const buildSubjects = (models: DecisionModels): Map<SubjectTool, SubjectModel> =>
  new Map(SUBJECT_TOOLS.map((tool) => [tool, createSubject(models, tool, tool)] as const));

const describeRule = (term: RuleTerms): string => `${term.rule.text} (${term.rule.origin}: ${term.rule.source})`;

const kindOf = (readBool: (term: Bool) => boolean, outcome: Outcome): DecisionKind => (readBool(outcome.deny) ? 'deny' : readBool(outcome.allow) ? 'allow' : 'ask');

const causeOf = (subject: SubjectModel, outcome: Outcome, kind: DecisionKind, readBool: (term: Bool) => boolean, mode: string): string => {
  const matching = (effect: string, pick: (term: RuleTerms) => Bool): RuleTerms | undefined =>
    subject.terms.find((term) => term.rule.effect === effect && readBool(pick(term)));
  if (kind === 'deny') {
    const hit = matching('deny', (term) => term.position) ?? matching('deny', (term) => term.incidental);
    return hit === undefined ? `${mode} mode refuses this tool` : `denied by ${describeRule(hit)}`;
  }
  if (kind === 'allow') {
    if (readBool(outcome.allowedByRule)) {
      const hit = matching('allow', (term) => term.strict);
      if (hit !== undefined) return `allowed by ${describeRule(hit)}`;
    }
    if (readBool(outcome.allowedByDefault)) return `allowed by the ${mode} mode default, no rule is involved`;
    const asked = matching('ask', (term) => term.position);
    return asked === undefined ? `allowed in ${mode} mode` : `allowed because ${mode} mode overrides ${describeRule(asked)}`;
  }
  if (readBool(outcome.guarded)) return 'a protected path always asks';
  const asked = matching('ask', (term) => term.position) ?? matching('ask', (term) => term.incidental);
  if (readBool(outcome.asked) && asked !== undefined) return `asks by ${describeRule(asked)}`;
  if (readBool(outcome.incidentalAsk)) return 'a deny rule appears only as an argument, which asks';
  return `no rule decides; the ${mode} mode default asks`;
};

const solveWithinBudget = (context: QueryContext, constraints: readonly Bool[]): Promise<SolveResult> => {
  const remainingMs = context.budget.remainingMs();
  if (remainingMs <= 0) return Promise.resolve({ status: 'unknown', reason: `the verification budget of ${context.budget.totalMs} ms was spent` });
  return context.models.smt.solve(constraints, Math.ceil(remainingMs));
};

const solveForWitness = async (
  context: QueryContext,
  subject: SubjectModel,
  constraints: readonly Bool[],
): Promise<{ result: SolveResult; witness: Witness | undefined }> => {
  const exclusions: Bool[] = [];
  for (;;) {
    const result = await solveWithinBudget(context, [...constraints, ...exclusions]);
    if (result.status !== 'sat') return { result, witness: undefined };
    const witness = subject.witness(result.read, result.readBool);
    const exclusion = subject.exclusion?.(witness);
    if (exclusion === undefined) return { result, witness };
    exclusions.push(exclusion);
  }
};

export const probe = async (
  context: QueryContext,
  property: PropertyId,
  subjectName: string,
  tool: SubjectTool,
  constraints: readonly Bool[],
  excluded: ReadonlySet<number> = new Set(),
): Promise<Probe> => {
  const { models, env, subjects, mismatches } = context;
  const subject = subjects.get(tool) as SubjectModel;
  const outcome = outcomeOf(models, subject, excluded);
  const { result, witness } = await solveForWitness(context, subject, [...subject.domain, ...constraints]);
  if (result.status === 'unsat') return { status: 'none' };
  if (result.status === 'unknown') return { status: 'unknown', reason: result.reason };
  if (witness === undefined) throw new Error('the solver found a model without a witness');
  const predicted = kindOf(result.readBool, outcome);
  const replay = await replayWitness(env, tool, witness, { kind: predicted, dependsOnDefault: result.readBool(outcome.byDefault) });
  const counterexample: Counterexample = { witness, predicted, cause: causeOf(subject, outcome, predicted, result.readBool, env.mode), replay };
  if (isMismatch(replay)) mismatches.push({ property, subject: subjectName, counterexample });
  return { status: 'found', counterexample };
};

export const predictDecision = async (context: QueryContext, tool: SubjectTool, witness: Witness): Promise<Prediction | undefined> => {
  const subject = context.subjects.get(tool) as SubjectModel;
  const outcome = outcomeOf(context.models, subject);
  if (subject.exclusion?.(witness) !== undefined) return undefined;
  const result = await solveWithinBudget(context, [...subject.domain, ...subject.bind(witness)]);
  if (result.status === 'unsat') return undefined;
  if (result.status === 'unknown') throw new Error(`the solver could not evaluate the model: ${result.reason}`);
  return { kind: kindOf(result.readBool, outcome), dependsOnDefault: result.readBool(outcome.byDefault) };
};

export const termsOf = (context: QueryContext, tool: SubjectTool): readonly RuleTerms[] => (context.subjects.get(tool) as SubjectModel).terms;

export const outcomeFor = (context: QueryContext, tool: SubjectTool, excluded?: ReadonlySet<number>): Outcome =>
  outcomeOf(context.models, context.subjects.get(tool) as SubjectModel, excluded);

