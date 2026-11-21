import { parseOutsideJson } from '@momonga/foundation';
import {
  actionableIssueCount,
  buildPolishPrompt,
  DEFAULT_POLISH_AUDIENCE,
  MAX_POLISH_ITERATIONS,
  POLISH_ISSUE_TYPES,
  POLISH_SEVERITIES,
  shouldStopPolish,
  validateClarityReview,
} from '@momonga/protocol';
import type {
  PolishEvaluationResult,
  PolishIssue,
  PolishIssueType,
  PolishRequest,
  PolishSeverity,
  PolishStopDecision,
  PolishTarget,
} from '@momonga/protocol';

export {
  actionableIssueCount,
  buildPolishPrompt,
  DEFAULT_POLISH_AUDIENCE,
  MAX_POLISH_ITERATIONS,
  POLISH_ISSUE_TYPES,
  POLISH_SEVERITIES,
  shouldStopPolish,
  validateClarityReview,
};
export type {
  PolishEvaluationResult,
  PolishIssue,
  PolishIssueType,
  PolishRequest,
  PolishSeverity,
  PolishStopDecision,
  PolishTarget,
};

export const parseClarityEvaluation = (raw: string): PolishEvaluationResult => {
  try {
    return validateClarityReview(parseOutsideJson(raw));
  } catch {
    return { ok: false, reason: 'clarity review output is not valid JSON' };
  }
};
