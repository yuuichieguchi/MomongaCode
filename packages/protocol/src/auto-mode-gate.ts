export type AutoModeSurface = 'tui' | 'cli';

export const AUTO_MODE_CHECK_COMMANDS = { tui: '/auto-mode check', cli: 'momonga auto-mode check' } as const satisfies Record<AutoModeSurface, string>;

export const AUTO_MODE_CAVEAT = 'auto reduces prompts but does not guarantee safety.';

export const AUTO_FIT_MEASUREMENTS = ['passed', 'did_not_pass', 'not_measured', 'unreadable'] as const;

export const AUTO_FIT_FAILED_BOUNDS = ['caseMinimum', 'falseAllow', 'falseBlock', 'unobserved'] as const;

export type AutoClassifierKey = { classifier: string; codeDigest: string; datasetDigest: string };

export type AutoClassifierFacts = {
  recordedAt: string;
  falseAllows: number;
  total: number;
  upperBound: number;
  failedBound?: (typeof AUTO_FIT_FAILED_BOUNDS)[number];
};

export type AutoClassifierRefusal = { file: string; reason: string };

export type AutoClassifierView = { model: string; key: AutoClassifierKey } & (
  | { measurement: 'not_measured' }
  | { measurement: 'passed' | 'did_not_pass'; facts: AutoClassifierFacts }
  | { measurement: 'unreadable'; refusal: AutoClassifierRefusal }
);

const FAILED_BOUND_TEXT = {
  caseMinimum: 'a case below its minimum pass rate',
  falseAllow: 'the false-allow bound',
  falseBlock: 'the false-block bound',
  unobserved: 'too many unobserved runs',
} as const satisfies Record<(typeof AUTO_FIT_FAILED_BOUNDS)[number], string>;

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const factsText = (facts: AutoClassifierFacts): string => `false allows ${facts.falseAllows}/${facts.total}, upper bound ${percent(facts.upperBound)}`;

export const autoModeNotice = ({ view, surface, shownModel }: { view: AutoClassifierView; surface: AutoModeSurface; shownModel: string }): string => {
  const command = AUTO_MODE_CHECK_COMMANDS[surface];
  const model = shownModel;
  if (view.measurement === 'not_measured') return `auto: classifier ${model} has not been measured for this version; run ${command}. ${AUTO_MODE_CAVEAT}`;
  if (view.measurement === 'unreadable') return `auto: the measurement record of classifier ${model} cannot be used (${view.refusal.reason}); run ${command} to measure again. ${AUTO_MODE_CAVEAT}`;
  const { facts } = view;
  const measured = `auto: classifier ${model} measured on ${facts.recordedAt.slice(0, 10)}`;
  if (view.measurement === 'passed') return `${measured}: passed (${factsText(facts)}). ${AUTO_MODE_CAVEAT}`;
  const failed = facts.failedBound === undefined ? '' : `; failed: ${FAILED_BOUND_TEXT[facts.failedBound]}`;
  return `${measured}: did not pass (${factsText(facts)}${failed}); run ${command} for the report. ${AUTO_MODE_CAVEAT}`;
};
