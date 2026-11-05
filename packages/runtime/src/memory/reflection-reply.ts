import { isRecord, parseOutsideJson } from '@momonga/foundation';
import { MEMORY_KINDS } from '@momonga/protocol';
import type { MemoryKind } from '@momonga/protocol';
import { MEMORY_TEXT_MAX_CHARS } from '@momonga/tools';

export type ReflectionCandidate = { text: string; kind: MemoryKind; paths: string[] };

export const REFLECTION_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MEMORY_TEXT_MAX_CHARS },
          kind: { type: 'string', enum: [...MEMORY_KINDS] },
          paths: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        required: ['text', 'kind', 'paths'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const;

const CANDIDATE_FIELDS: readonly string[] = ['text', 'kind', 'paths'];

const schemaFailure = (detail: string): { error: string } => ({ error: `output failed the schema: ${detail}` });

const candidateOf = (value: unknown, index: number): ReflectionCandidate | { error: string } => {
  if (!isRecord(value)) return schemaFailure(`candidates[${index}] is not an object`);
  const extra = Object.keys(value).find((key) => !CANDIDATE_FIELDS.includes(key));
  if (extra !== undefined) return schemaFailure(`candidates[${index}] has the unexpected field ${JSON.stringify(extra)}`);
  const { text, kind, paths } = value;
  if (typeof text !== 'string' || text.length === 0 || text.length > MEMORY_TEXT_MAX_CHARS) {
    return schemaFailure(`candidates[${index}].text must be a string of 1 to ${MEMORY_TEXT_MAX_CHARS} characters`);
  }
  const known = MEMORY_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) return schemaFailure(`candidates[${index}].kind must be one of ${MEMORY_KINDS.join(', ')}`);
  const pathsFailure = schemaFailure(`candidates[${index}].paths must be an array of non-empty strings`);
  if (!Array.isArray(paths)) return pathsFailure;
  const named: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || entry.length === 0) return pathsFailure;
    named.push(entry);
  }
  return { text, kind: known, paths: named };
};

export const parseReflectionReply = (text: string): { candidates: ReflectionCandidate[] } | { error: string } => {
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    return schemaFailure(`the reply is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(value)) return schemaFailure('the reply is not a JSON object');
  const extra = Object.keys(value).find((key) => key !== 'candidates');
  if (extra !== undefined) return schemaFailure(`the reply has the unexpected field ${JSON.stringify(extra)}`);
  if (!Array.isArray(value['candidates'])) return schemaFailure('candidates must be an array');
  const candidates: ReflectionCandidate[] = [];
  for (const [index, entry] of value['candidates'].entries()) {
    const parsed = candidateOf(entry, index);
    if ('error' in parsed) return parsed;
    candidates.push(parsed);
  }
  return { candidates };
};
