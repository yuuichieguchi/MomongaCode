import { canonicalJson } from './canonical-json.ts';
import { parseOutsideJson } from './json-depth.ts';
import type { ProductValidator } from './product-schema.ts';
import type { UntrustedError } from './untrusted-schema.ts';

export type JsonReplyPath = 'enforced' | 'prompt';

export type JsonReplyInput = { text: string; incomplete?: string | undefined; path?: JsonReplyPath | undefined };

export type JsonReplyRead<T> = { value: T } | { error: string };

const CONTRACT_HEAD = 'Reply with one JSON value and nothing else: no text before or after it and no code fence. It must be valid under this JSON Schema:';

const PATH_LABELS: Record<JsonReplyPath, string> = {
  enforced: ' (reply enforced by the target)',
  prompt: ' (reply not enforced by the target)',
};

export const describeFirstError = (errors: readonly UntrustedError[]): string => {
  const first = errors[0];
  if (first === undefined) return '/: schema violation';
  return `${first.instancePath === '' ? '/' : first.instancePath}: ${first.message}`;
};

export const jsonReplyInstructions = (instructions: string, schema: Record<string, unknown>): string => `${instructions}\n${CONTRACT_HEAD}\n${canonicalJson(schema)}`;

export const readJsonReply = <T>(validator: ProductValidator<T>, reply: JsonReplyInput): JsonReplyRead<T> => {
  const failure = (detail: string): { error: string } => ({
    error: `output failed the schema${reply.path === undefined ? '' : PATH_LABELS[reply.path]}: ${detail}`,
  });
  if (reply.incomplete !== undefined) return failure(`the response was incomplete (${reply.incomplete})`);
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(reply.text);
  } catch (error) {
    return failure(`the reply is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const verdict = validator(parsed);
  if (verdict.valid) return { value: verdict.value };
  return failure(describeFirstError(verdict.errors));
};
