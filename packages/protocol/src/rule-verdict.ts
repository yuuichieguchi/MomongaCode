import type { PermissionMode } from './run-types.ts';

export const POLICY_REFUTED_CODE = 'policy_refuted';

export const POLICY_VERDICT_NOTICE_CODE = 'policy_verdict';

export const RULE_VERIFY_BUDGET_MS = 60_000;

export const RULE_VERIFY_LOAD_ALLOWANCE_MS = 10_000;

export const RULE_VERDICTS = ['proved', 'refuted', 'unknown', 'failed', 'not-needed'] as const;

export type RuleVerdictKind = (typeof RULE_VERDICTS)[number];

export const FINAL_RULE_VERDICTS = ['proved', 'refuted'] as const satisfies readonly RuleVerdictKind[];

export const isFinalRuleVerdict = (verdict: { verdict: string }): boolean => FINAL_RULE_VERDICTS.some((kind) => kind === verdict.verdict);

export type RuleRefutation = { property: string; subject: string; message: string; counterexample?: string };

export const REFUSING_PROPERTIES = ['secret-reach', 'superseded-forms', 'mandate-holds'] as const;

export const RULE_NOTE_KINDS = ['duplicate', 'no-effect', 'never-matches', 'implied-by-mode', 'undecided'] as const;

export type RuleNoteKind = (typeof RULE_NOTE_KINDS)[number];

export type RuleNoteRule = { text: string; origin: string; source: string };

export type RuleNote = { kind: RuleNoteKind; rules: RuleNoteRule[]; modes: string[]; message: string };

export type RuleVerdictPhase = { phase: string; ms: number };

export type RuleVerdict = {
  verdict: RuleVerdictKind;
  solver: string;
  refuted: RuleRefutation[];
  notes?: RuleNote[];
  unknown: { property: string; reason: string }[];
  notProved: string[];
  phases?: RuleVerdictPhase[];
};

export type PolicyVerifyRequest = { project: string; mode?: PermissionMode; secrets: string[]; mandate?: string };

export type PolicyVerifyResponse = { fingerprint: string; stored: boolean; exitCode: number; text: string; findings: Record<string, unknown> };

export type PinnedRuleVerdict = RuleVerdict & { fingerprint: string };

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isRefutations = (value: unknown): value is RuleRefutation[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      isObject(entry) &&
      typeof entry['property'] === 'string' &&
      typeof entry['subject'] === 'string' &&
      typeof entry['message'] === 'string' &&
      (entry['counterexample'] === undefined || typeof entry['counterexample'] === 'string'),
  );

const isRuleNotes = (value: unknown): value is RuleNote[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      isObject(entry) &&
      RULE_NOTE_KINDS.some((kind) => kind === entry['kind']) &&
      Array.isArray(entry['rules']) &&
      entry['rules'].every((rule) => isObject(rule) && typeof rule['text'] === 'string' && typeof rule['origin'] === 'string' && typeof rule['source'] === 'string') &&
      isStrings(entry['modes']) &&
      typeof entry['message'] === 'string',
  );

const isPhases = (value: unknown): value is RuleVerdictPhase[] =>
  Array.isArray(value) && value.every((entry) => isObject(entry) && typeof entry['phase'] === 'string' && typeof entry['ms'] === 'number');

export const isRuleVerdict = (value: unknown): value is RuleVerdict =>
  isObject(value) &&
  RULE_VERDICTS.some((kind) => kind === value['verdict']) &&
  typeof value['solver'] === 'string' &&
  isRefutations(value['refuted']) &&
  (value['notes'] === undefined || isRuleNotes(value['notes'])) &&
  Array.isArray(value['unknown']) &&
  value['unknown'].every((entry) => isObject(entry) && typeof entry['property'] === 'string' && typeof entry['reason'] === 'string') &&
  isStrings(value['notProved']) &&
  (value['phases'] === undefined || isPhases(value['phases']));

export const isPinnedRuleVerdict = (value: unknown): value is PinnedRuleVerdict => isRuleVerdict(value) && typeof (value as Record<string, unknown>)['fingerprint'] === 'string';

const RULE_PROPERTY_WORDS: Readonly<Record<string, string>> = {
  'deny-precedence': 'a deny rule wins over every allow rule',
  'secret-reach': 'no allow rule you wrote opens a secret location',
  'rule-consistency': 'the rules agree with each other',
  'bash-admission': 'a command is admitted only as the rules say',
  'superseded-forms': 'a run under a mandate uses the dedicated operation instead of the command it replaces',
  'mandate-holds': 'a run under a mandate stays inside it',
};

export const rulePropertyInWords = (property: string): string => {
  const words = RULE_PROPERTY_WORDS[property];
  if (words === undefined) throw new Error(`the rule property ${property} has no words`);
  return words;
};

const refutationText = (refutation: RuleRefutation): string =>
  `The property that ${rulePropertyInWords(refutation.property)} is refuted for ${refutation.subject}: ${refutation.message}${refutation.counterexample === undefined ? '' : ` (for example ${refutation.counterexample})`}.`;

const WAY_FORWARD = 'run "momonga policy verify" to see the full report.';

const VERDICT_SUMMARY: Readonly<Record<RuleVerdictKind, string>> = {
  proved: 'no rule is refuted',
  refuted: 'a property is refuted',
  unknown: 'not every property was decided',
  failed: 'the verification did not finish',
  'not-needed': 'no rule is refuted',
};

export const refusingRefutations = (verdict: Pick<RuleVerdict, 'refuted'>): RuleRefutation[] =>
  verdict.refuted.filter((refutation) => REFUSING_PROPERTIES.some((property) => property === refutation.property));

export const policyRefutedMessage = (verdict: RuleVerdict): string =>
  [
    'The run was not started because a permission rule breaks a protection.',
    ...refusingRefutations(verdict).map(refutationText),
    `Change that rule in the settings or the mandate, then ${WAY_FORWARD}`,
  ].join(' ');

export const policyVerdictNotice = (verdict: PinnedRuleVerdict): string => {
  const unknown = verdict.unknown.map((entry) => `the property that ${rulePropertyInWords(entry.property)} (${entry.reason})`);
  const settled = verdict.refuted.length === 0 && unknown.length === 0;
  return [
    `The permission rules changed during the run and were verified again: ${VERDICT_SUMMARY[verdict.verdict]}.`,
    ...verdict.refuted.map(refutationText),
    ...(unknown.length === 0 ? [] : [`Not decided: ${unknown.join('; ')}.`]),
    ...(verdict.notProved.length === 0 ? [] : [`Not proved: ${verdict.notProved.join(' ')}`]),
    ...(settled ? [] : [`Run "momonga policy verify" to see the full report.`]),
  ].join(' ');
};
