export const POLISH_ISSUE_TYPES = [
  'undefined_term',
  'missing_context',
  'logical_gap',
  'vague_action',
  'excessive_abstraction',
] as const;

export type PolishIssueType = (typeof POLISH_ISSUE_TYPES)[number];

export const POLISH_SEVERITIES = ['low', 'medium', 'high'] as const;

export type PolishSeverity = (typeof POLISH_SEVERITIES)[number];

export const MAX_POLISH_ITERATIONS = 2;

export const DEFAULT_POLISH_AUDIENCE = 'このリポジトリの開発者';

export type PolishIssue = {
  readonly span: string;
  readonly issue_type: PolishIssueType;
  readonly severity: PolishSeverity;
  readonly evidence: string;
  readonly revision_instruction: string;
  readonly requires_source_check: boolean;
};

export type PolishEvaluationResult =
  | { readonly ok: true; readonly issues: readonly PolishIssue[] }
  | { readonly ok: false; readonly reason: string };

export type PolishStopDecision = {
  readonly stop: boolean;
  readonly reason: 'no_actionable_issues' | 'max_iterations' | 'no_improvement' | 'continue';
};

export type PolishTarget =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string };

export type PolishRequest = {
  readonly target: PolishTarget;
  readonly audience?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export const parseClarityEvaluation = (raw: string): PolishEvaluationResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'clarity evaluation output is not valid JSON' };
  }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['issues']) ? parsed['issues'] : undefined;
  if (list === undefined) {
    return { ok: false, reason: 'clarity evaluation must be a JSON array or an object with an "issues" array' };
  }
  const issues: PolishIssue[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (!isRecord(entry)) return { ok: false, reason: `issue[${index}] must be an object` };
    const { span, issue_type, severity, evidence, revision_instruction, requires_source_check } = entry;
    if (!isNonEmptyString(span)) return { ok: false, reason: `issue[${index}].span must be a non-empty string` };
    if (typeof issue_type !== 'string' || !(POLISH_ISSUE_TYPES as readonly string[]).includes(issue_type)) {
      return { ok: false, reason: `issue[${index}].issue_type must be one of ${POLISH_ISSUE_TYPES.join(', ')}` };
    }
    if (typeof severity !== 'string' || !(POLISH_SEVERITIES as readonly string[]).includes(severity)) {
      return { ok: false, reason: `issue[${index}].severity must be one of ${POLISH_SEVERITIES.join(', ')}` };
    }
    if (!isNonEmptyString(evidence)) return { ok: false, reason: `issue[${index}].evidence must be a non-empty string` };
    if (!isNonEmptyString(revision_instruction)) {
      return { ok: false, reason: `issue[${index}].revision_instruction must be a non-empty string` };
    }
    if (typeof requires_source_check !== 'boolean') {
      return { ok: false, reason: `issue[${index}].requires_source_check must be a boolean` };
    }
    issues.push({
      span,
      issue_type: issue_type as PolishIssueType,
      severity: severity as PolishSeverity,
      evidence,
      revision_instruction,
      requires_source_check,
    });
  }
  return { ok: true, issues };
};

export const actionableIssueCount = (issues: readonly PolishIssue[]): number =>
  issues.filter((issue) => issue.severity === 'high' || issue.severity === 'medium').length;

export const shouldStopPolish = (
  iteration: number,
  issues: readonly PolishIssue[],
  previousActionableCount?: number,
): PolishStopDecision => {
  const actionable = actionableIssueCount(issues);
  if (actionable === 0) return { stop: true, reason: 'no_actionable_issues' };
  if (iteration >= MAX_POLISH_ITERATIONS) return { stop: true, reason: 'max_iterations' };
  if (previousActionableCount !== undefined && actionable >= previousActionableCount) {
    return { stop: true, reason: 'no_improvement' };
  }
  return { stop: false, reason: 'continue' };
};

export const buildPolishPrompt = (request: PolishRequest): string => {
  const audience = request.audience?.trim() || DEFAULT_POLISH_AUDIENCE;
  const targetBlock =
    request.target.kind === 'file'
      ? `Target file: ${request.target.path}\nRead this file first before evaluating.`
      : `Target text (previous assistant response):\n---\n${request.target.text}\n---`;

  const outputRule =
    request.target.kind === 'file'
      ? 'Output: present the localized diff and any unresolved items, then apply edits to the target file through the normal file-edit tool (subject to user confirmation).'
      : 'Output: present the polished text directly in your response, followed by any unresolved items (if any).';

  return [
    'Run the bounded clarity-and-factuality polish workflow on the target below.',
    `Target audience: ${audience}`,
    '',
    targetBlock,
    '',
    'Workflow (maximum 2 iterations):',
    `1. Clarity Evaluator: Do NOT assign numeric scores. Identify concrete defects for the target audience using issue types (${POLISH_ISSUE_TYPES.join(', ')}), severity (low/medium/high), exact span, evidence, revision instruction, and whether a codebase source check is required.`,
    '2. Semantic Validator: Verify technical claims, symbol names, file paths, and behavior against the actual codebase using read-only tools. Flag any contradiction or dropped specification.',
    '3. Editor (localized revision): Revise ONLY the spans with high or medium severity defects while preserving all verified facts and constraints. Never invent facts absent from the source text or codebase; list any unresolvable gaps under "Unresolved items".',
    `4. Stopping rule: Stop immediately when no high/medium defects remain, when an iteration fails to reduce high/medium defects, or after ${MAX_POLISH_ITERATIONS} iterations. If evaluation or codebase verification cannot be completed, stop safely and report the last valid draft along with what verification remains incomplete.`,
    '',
    outputRule,
  ].join('\n');
};
