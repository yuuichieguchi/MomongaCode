export const POLICY_REFUTED_CODE = 'policy_refuted';

export const POLICY_VERDICT_NOTICE_CODE = 'policy_verdict';

export const RULE_VERIFY_BUDGET_MS = 60_000;

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

export type PutRuleVerdictRequest = { verdict: RuleVerdict };

export const RULE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

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

const refutationText = (refutation: RuleRefutation): string =>
  `${refutation.property} (${refutation.subject}): ${refutation.message}${refutation.counterexample === undefined ? '' : `; counterexample: ${refutation.counterexample}`}`;

export const refusingRefutations = (verdict: Pick<RuleVerdict, 'refuted'>): RuleRefutation[] =>
  verdict.refuted.filter((refutation) => REFUSING_PROPERTIES.some((property) => property === refutation.property));

export const policyRefutedMessage = (verdict: RuleVerdict): string =>
  `The permission rules were refuted, so the run was refused: ${refusingRefutations(verdict).map(refutationText).join(' | ')}. Change the rules; "momonga policy verify" prints the full report.`;

export const policyVerdictNotice = (verdict: PinnedRuleVerdict): string => {
  const head = `The permission rules changed during the run and were verified again (${verdict.solver}, fingerprint ${verdict.fingerprint}): ${verdict.verdict}.`;
  const refuted = verdict.refuted.map(refutationText);
  const unknown = verdict.unknown.map((entry) => `${entry.property}: ${entry.reason}`);
  return [
    head,
    ...(refuted.length === 0 ? [] : [`Refuted: ${refuted.join(' | ')}.`]),
    ...(unknown.length === 0 ? [] : [`Not decided: ${unknown.join(' | ')}.`]),
    `Not proved: ${verdict.notProved.join(' ')}`,
  ].join(' ');
};
