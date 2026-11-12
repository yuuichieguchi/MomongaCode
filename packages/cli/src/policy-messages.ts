import { HOOK_STOPPED_CODE, PLAN_NOT_ELIGIBLE_CODE, PLAN_USE_NOT_ENABLED_CODE, PRECONDITION_FAILED_CODE, SIGN_IN_COMMAND, SIGN_IN_REQUIRED_CODE, TARGET_NOT_READY, TUI_SIGN_IN_COMMAND, USER_PROMPT_BLOCKED_CODE } from '@momonga/protocol';
import type { PlanAccountRef, Surface } from '@momonga/protocol';
import type { PermissionDenial, PermissionDenialSource, PublicRunEvent, ResidualRiskCode, RunReport } from '@momonga/protocol';

type HookCompleted = Extract<PublicRunEvent, { type: 'hook.completed' }>;
type Classified = Extract<PublicRunEvent, { type: 'tool.permission.classified' }>;
type Verified = Extract<PublicRunEvent, { type: 'verification.completed' }>;
type ReportedCondition = RunReport['conditions'][number];

export type Level = 'info' | 'warning' | 'error';

const HOOK_OUTCOME_WORDS: Readonly<Record<HookCompleted['outcome'], string>> = {
  success: 'succeeded',
  blocked: 'blocked',
  error: 'failed',
  timed_out: 'timed out',
  cancelled: 'was cancelled',
};

const HOOK_OUTCOME_LEVELS: Readonly<Record<HookCompleted['outcome'], Level>> = {
  success: 'info',
  blocked: 'warning',
  error: 'error',
  timed_out: 'error',
  cancelled: 'info',
};

const DENIAL_SOURCE_WORDS: Readonly<Record<PermissionDenialSource, string>> = {
  sandbox: 'the sandbox',
  rule: 'a permission rule',
  mode: 'the permission mode',
  setting: 'a setting',
  hook: 'a hook',
  mandate: 'the mandate of this run',
  superseded: 'the mandate of this run, which replaces the command',
  held: 'a hold for approval',
};

export const hookLevel = (event: HookCompleted): Level => HOOK_OUTCOME_LEVELS[event.outcome];

const VERIFICATION_WORDS: Readonly<Record<Verified['outcome'], string>> = {
  passed: 'passed',
  failed: 'failed',
  timed_out: 'timed out',
  cancelled: 'was cancelled',
  spawn_error: 'could not be started',
};

export const verificationLevel = (event: Verified): Level => (event.outcome === 'passed' ? 'info' : 'warning');

export const describeVerification = (event: Verified, agent?: string): string =>
  `completion condition${agent === undefined ? '' : ` of subagent ${agent}`} ${VERIFICATION_WORDS[event.outcome]}${event.exitCode === undefined || event.outcome === 'passed' ? '' : ` (exit ${event.exitCode})`}: ${event.command}`;

export const CONDITION_STATE_WORDS: Readonly<Record<ReportedCondition['state'], string>> = {
  passed: 'passed',
  not_needed: 'was not needed',
  failed: 'failed',
  timed_out: 'timed out',
  cancelled: 'was cancelled',
  spawn_error: 'could not be started',
  stale: 'passed before the last change and was not run again',
  not_run: 'was not run',
};

export const HOW_TO_DECLARE_CHECK = 'to declare a check, accept the one the terminal UI proposes in this folder, or set verification.commands in the settings';

export const RESIDUAL_RISK_WORDS: Readonly<Record<ResidualRiskCode, string>> = {
  no_condition_declared_after_mutation: `the run changed files and no completion condition was declared (${HOW_TO_DECLARE_CHECK})`,
  mutation_without_known_paths: 'changes whose files are not known',
  unknown_effect_calls: 'calls whose effect is not known',
  permission_denials: 'calls that were denied',
  child_runs_not_completed: 'child runs that did not complete',
  output_truncated: 'tool outputs that were cut short',
  requirements_unchecked: 'requirements that have no mechanical check',
};

export const unmetConditionLines = (report: RunReport): string[] => {
  if (report.conditions.length === 0) return ['  no completion condition was declared for a run that changed the workspace'];
  return report.conditions.flatMap((condition) =>
    condition.state === 'passed' || condition.state === 'not_needed'
      ? []
      : [`  unmet: ${condition.command} ${CONDITION_STATE_WORDS[condition.state]}${condition.last?.exitCode === undefined || condition.state !== 'failed' ? '' : ` (exit ${condition.last.exitCode})`}`],
  );
};

export const describeHook = (event: HookCompleted, agent?: string): string[] => {
  const facts = [
    event.exitCode === undefined ? undefined : `exit ${event.exitCode}`,
    event.decision === undefined ? undefined : `decision ${event.decision}`,
    event.halted === true ? 'halted the run' : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  return [
    `hook ${event.hookEvent}${agent === undefined ? '' : ` of subagent ${agent}`} ${HOOK_OUTCOME_WORDS[event.outcome]}${facts.length === 0 ? '' : ` (${facts.join(', ')})`}: ${event.command}`,
    ...(event.message === undefined ? [] : [`  ${event.message}`]),
    ...(event.systemMessage === undefined ? [] : [`  ${event.systemMessage}`]),
    ...(event.stopReason === undefined ? [] : [`  stop reason: ${event.stopReason}`]),
  ];
};

export const classificationLevel = (event: Classified): Level => (event.failure === undefined ? 'info' : 'warning');

export const describeClassification = (event: Classified, subject: string): string => {
  const classifier = event.model === undefined ? 'the classifier' : `classifier ${event.model}`;
  if (event.failure !== undefined) return `auto mode could not classify ${subject}, so it asks you: ${event.failure}`;
  const judged = `${classifier} judged ${subject} ${event.verdict ?? 'unclassified'}${event.confidence === undefined ? '' : ` with ${event.confidence} confidence`}`;
  const rationale = event.rationale === undefined ? '' : `: ${event.rationale}`;
  return event.outcome === 'allow' ? `auto mode allowed ${subject}; ${judged}${rationale}` : `auto mode asks you about ${subject}; ${judged}${rationale}`;
};

export const describeDenial = (denial: PermissionDenial): string => `denied by ${DENIAL_SOURCE_WORDS[denial.source]}: ${denial.reason}`;

const PRODUCT_COMPOSED_CODES: ReadonlySet<string> = new Set([PRECONDITION_FAILED_CODE, TARGET_NOT_READY]);

export const signInCommandOf = (surface: Surface, plan: PlanAccountRef | undefined): string => {
  if (surface === 'tui') return TUI_SIGN_IN_COMMAND;
  if (plan === undefined) return SIGN_IN_COMMAND;
  return plan.account === undefined ? `${SIGN_IN_COMMAND} ${plan.profile}` : `${SIGN_IN_COMMAND} ${plan.profile} --account ${plan.account}`;
};

export const reconsentCommand = (plan: PlanAccountRef): string => `${signInCommandOf('cli', plan)} --reconsent`;

const defaultRunErrorLines = (error: { code: string; message: string }): string[] => {
  const [first = '', ...rest] = PRODUCT_COMPOSED_CODES.has(error.code) ? error.message.split('\n') : [error.message];
  return [`${error.code}: ${first}`, ...rest];
};

const planRunErrorLines = (error: { code: string; message: string }, plan: PlanAccountRef): string[] | undefined => {
  switch (error.code) {
    case PLAN_USE_NOT_ENABLED_CODE:
      return [`${error.message} · Run ${reconsentCommand(plan)} to enable it`, `cause: ${error.code}`];
    case PLAN_NOT_ELIGIBLE_CODE:
      return [error.message, `cause: ${error.code}`, `Run ${SIGN_IN_COMMAND} ${plan.profile} --account <new label> to use another account, or use an API key.`];
    default:
      return undefined;
  }
};

export const describeRunError = (error: { code: string; message: string; plan?: PlanAccountRef }, surface: Surface): string[] => {
  const planLines = surface !== 'tui' && error.plan !== undefined ? planRunErrorLines(error, error.plan) : undefined;
  if (planLines !== undefined) return planLines;
  switch (error.code) {
    case SIGN_IN_REQUIRED_CODE:
      return [`${error.message} · Run ${signInCommandOf(surface, error.plan)} to sign in again`, `cause: ${error.code}`];
    case USER_PROMPT_BLOCKED_CODE:
      return [`a UserPromptSubmit hook blocked the prompt: ${error.message}`];
    case HOOK_STOPPED_CODE:
      return [`a hook stopped the run: ${error.message}`];
    default:
      return defaultRunErrorLines(error);
  }
};
