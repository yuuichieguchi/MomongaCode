import { HOOK_STOPPED_CODE, PRECONDITION_FAILED_CODE, USER_PROMPT_BLOCKED_CODE } from '@momonga/protocol';
import type { PermissionDenial, PermissionDenialSource, PublicRunEvent } from '@momonga/protocol';

type HookCompleted = Extract<PublicRunEvent, { type: 'hook.completed' }>;
type Classified = Extract<PublicRunEvent, { type: 'tool.permission.classified' }>;

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
  hook: 'a hook',
};

export const hookLevel = (event: HookCompleted): Level => HOOK_OUTCOME_LEVELS[event.outcome];

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
  const classifier = event.alias === undefined ? 'the classifier' : `classifier ${event.alias}`;
  if (event.failure !== undefined) return `auto mode could not classify ${subject}, so it asks you: ${event.failure}`;
  const judged = `${classifier} judged ${subject} ${event.verdict ?? 'unclassified'}${event.confidence === undefined ? '' : ` with ${event.confidence} confidence`}`;
  const rationale = event.rationale === undefined ? '' : `: ${event.rationale}`;
  return event.outcome === 'allow' ? `auto mode allowed ${subject}; ${judged}${rationale}` : `auto mode asks you about ${subject}; ${judged}${rationale}`;
};

export const describeDenial = (denial: PermissionDenial): string => `denied by ${DENIAL_SOURCE_WORDS[denial.source]}: ${denial.reason}`;

const PRODUCT_COMPOSED_CODES: ReadonlySet<string> = new Set([PRECONDITION_FAILED_CODE]);

export const describeRunError = (error: { code: string; message: string }): string[] => {
  switch (error.code) {
    case USER_PROMPT_BLOCKED_CODE:
      return [`a UserPromptSubmit hook blocked the prompt: ${error.message}`];
    case HOOK_STOPPED_CODE:
      return [`a hook stopped the run: ${error.message}`];
    default: {
      const [first = '', ...rest] = PRODUCT_COMPOSED_CODES.has(error.code) ? error.message.split('\n') : [error.message];
      return [`${error.code}: ${first}`, ...rest];
    }
  }
};
