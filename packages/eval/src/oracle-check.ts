import { nonEmptyString as text } from '@momonga/protocol';
export const EVIDENCE_KINDS = ['acceptance', 'unit', 'regression', 'lint', 'static', 'security'] as const;

export type OracleCheck =
  | { id: string; kind: 'command'; run: string; expectExit: number; evidence: (typeof EVIDENCE_KINDS)[number]; timeoutMs: number }
  | { id: string; kind: 'unchangedPaths'; paths: string[] }
  | { id: string; kind: 'changedPathsWithin'; paths: string[] };

const count = { type: 'integer', minimum: 1 } as const;
const paths = { type: 'array', minItems: 1, items: text } as const;

const oracleCheck = (kind: string, properties: Record<string, unknown>, required: readonly string[]) =>
  ({
    type: 'object',
    properties: { id: text, kind: { const: kind }, ...properties },
    required: ['id', 'kind', ...required],
    additionalProperties: false,
  }) as const;

export const ORACLE_CHECKS_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    oneOf: [
      oracleCheck('command', { run: text, expectExit: { type: 'integer', minimum: 0 }, evidence: { enum: [...EVIDENCE_KINDS] }, timeoutMs: count }, ['run', 'expectExit', 'evidence', 'timeoutMs']),
      oracleCheck('unchangedPaths', { paths }, ['paths']),
      oracleCheck('changedPathsWithin', { paths }, ['paths']),
    ],
  },
} as const;
