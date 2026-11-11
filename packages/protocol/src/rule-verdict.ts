export const POLICY_REFUTED_CODE = 'policy_refuted';

export const POLICY_VERDICT_NOTICE_CODE = 'policy_verdict';

export const RULE_VERIFY_BUDGET_MS = 60_000;

export const RULE_VERDICTS = ['proved', 'refuted', 'unknown'] as const;

export type RuleVerdictKind = (typeof RULE_VERDICTS)[number];

export type RuleRefutation = { property: string; subject: string; message: string; counterexample?: string };

export type RuleVerdict = {
  verdict: RuleVerdictKind;
  solver: string;
  refuted: RuleRefutation[];
  byModeDefault?: RuleRefutation[];
  unknown: { property: string; reason: string }[];
  notProved: string[];
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

export const isRuleVerdict = (value: unknown): value is RuleVerdict =>
  isObject(value) &&
  RULE_VERDICTS.some((kind) => kind === value['verdict']) &&
  typeof value['solver'] === 'string' &&
  isRefutations(value['refuted']) &&
  (value['byModeDefault'] === undefined || isRefutations(value['byModeDefault'])) &&
  Array.isArray(value['unknown']) &&
  value['unknown'].every((entry) => isObject(entry) && typeof entry['property'] === 'string' && typeof entry['reason'] === 'string') &&
  isStrings(value['notProved']);

export const isPinnedRuleVerdict = (value: unknown): value is PinnedRuleVerdict => isRuleVerdict(value) && typeof (value as Record<string, unknown>)['fingerprint'] === 'string';

const refutationText = (refutation: RuleRefutation): string =>
  `${refutation.property} (${refutation.subject}): ${refutation.message}${refutation.counterexample === undefined ? '' : `; counterexample: ${refutation.counterexample}`}`;

export const policyRefutedMessage = (verdict: RuleVerdict): string =>
  `The permission rules were refuted, so the run was refused: ${verdict.refuted.map(refutationText).join(' | ')}. Change the rules; "momonga policy verify" prints the full report.`;

export const policyVerdictNotice = (verdict: PinnedRuleVerdict): string => {
  const head = `The permission rules changed during the run and were verified again (${verdict.solver}, fingerprint ${verdict.fingerprint}): ${verdict.verdict}.`;
  const refuted = verdict.refuted.map(refutationText);
  const byModeDefault = (verdict.byModeDefault ?? []).map(refutationText);
  const unknown = verdict.unknown.map((entry) => `${entry.property}: ${entry.reason}`);
  return [
    head,
    ...(refuted.length === 0 ? [] : [`Refuted: ${refuted.join(' | ')}.`]),
    ...(byModeDefault.length === 0 ? [] : [`By the mode default, not by a rule: ${byModeDefault.join(' | ')}.`]),
    ...(unknown.length === 0 ? [] : [`Not decided: ${unknown.join(' | ')}.`]),
    `Not proved: ${verdict.notProved.join(' ')}`,
  ].join(' ');
};
