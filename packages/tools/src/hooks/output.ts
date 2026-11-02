import { HOOK_PRE_TOOL_DECISIONS } from '@momonga/protocol';
import type { HookEvent, HookPreToolDecision } from '@momonga/protocol';

export type ParsedHookOutput = {
  decision?: HookPreToolDecision | 'block';
  reason?: string;
  additionalContext?: string;
  systemMessage?: string;
  plainText?: string;
};

export type HookOutputResult = { ok: true; value: ParsedHookOutput } | { ok: false; message: string };

const UNSUPPORTED_SPECIFIC_FIELDS = ['updatedInput', 'updatedToolOutput', 'updatedMCPToolOutput'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (record: Record<string, unknown>, key: string, where: string): string | undefined | { problem: string } => {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : { problem: `${where}${key} must be a string` };
};

const isProblem = (value: string | undefined | { problem: string }): value is { problem: string } => typeof value === 'object';

const fail = (message: string): HookOutputResult => ({ ok: false, message });

const specificOutput = (event: HookEvent, record: Record<string, unknown>): HookOutputResult => {
  for (const field of UNSUPPORTED_SPECIFIC_FIELDS) {
    if (field in record) return fail(`hookSpecificOutput.${field} is not supported`);
  }
  const name = record['hookEventName'];
  if (name !== undefined && name !== event) return fail(`hookSpecificOutput.hookEventName is ${JSON.stringify(name)} but the hook ran for ${event}`);
  const value: ParsedHookOutput = {};
  const context = optionalString(record, 'additionalContext', 'hookSpecificOutput.');
  if (isProblem(context)) return fail(context.problem);
  if (context !== undefined) value.additionalContext = context;
  const reason = optionalString(record, 'permissionDecisionReason', 'hookSpecificOutput.');
  if (isProblem(reason)) return fail(reason.problem);
  const decision = record['permissionDecision'];
  if (decision !== undefined) {
    if (event !== 'PreToolUse') return fail(`hookSpecificOutput.permissionDecision applies only to PreToolUse, not ${event}`);
    const known = HOOK_PRE_TOOL_DECISIONS.find((candidate) => candidate === decision);
    if (known === undefined) return fail(`hookSpecificOutput.permissionDecision ${JSON.stringify(decision)} is not supported; use allow, ask or deny`);
    value.decision = known;
    if (reason !== undefined) value.reason = reason;
  }
  return { ok: true, value };
};

export const parseHookOutput = (event: HookEvent, stdout: string): HookOutputResult => {
  const text = stdout.trim();
  if (text === '') return { ok: true, value: {} };
  if (!text.startsWith('{')) return { ok: true, value: { plainText: text } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(`the output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) return fail('the output is not a JSON object');
  if (parsed['continue'] === false) return fail('continue: false is not supported');
  const value: ParsedHookOutput = {};
  const systemMessage = optionalString(parsed, 'systemMessage', '');
  if (isProblem(systemMessage)) return fail(systemMessage.problem);
  if (systemMessage !== undefined) value.systemMessage = systemMessage;
  const reason = optionalString(parsed, 'reason', '');
  if (isProblem(reason)) return fail(reason.problem);
  if (parsed['decision'] !== undefined) {
    if (parsed['decision'] !== 'block') return fail(`decision ${JSON.stringify(parsed['decision'])} is not supported; only "block" is`);
    if (event === 'PreToolUse' || event === 'SessionStart') return fail(`a top-level decision does not apply to ${event}`);
    value.decision = 'block';
    if (reason !== undefined) value.reason = reason;
  }
  const specific = parsed['hookSpecificOutput'];
  if (specific !== undefined) {
    if (!isRecord(specific)) return fail('hookSpecificOutput must be an object');
    const result = specificOutput(event, specific);
    if (!result.ok) return result;
    Object.assign(value, result.value);
  }
  return { ok: true, value };
};
