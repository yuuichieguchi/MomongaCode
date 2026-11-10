import github from './descriptors/github.json' with { type: 'json' };
import { defineProductSchema } from '@momonga/foundation';
import { FORGE_VOCABULARY } from '../operations/spec.ts';
import type { ForgeOperationName } from '../operations/spec.ts';
import { PATH_PATTERN } from './jsonpath.ts';

export class ForgeDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeDescriptorError';
  }
}

export type ForgeOperationDescriptor = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
  readonly success: readonly number[];
  readonly alreadyExists?: readonly number[];
  readonly conflict?: readonly number[];
  readonly items?: string;
  readonly result: Readonly<Record<string, string>>;
};

export type ForgeDescriptor = {
  readonly id: string;
  readonly auth: { readonly header: string; readonly prefix: string };
  readonly operations: Readonly<Record<ForgeOperationName, ForgeOperationDescriptor>>;
};

const STATUSES = { type: 'array', items: { type: 'integer', minimum: 100, maximum: 599 } } as const;
const TEMPLATE_MAP = { type: 'object', additionalProperties: { type: 'string' } } as const;
const PATHS = { type: 'object', additionalProperties: { type: 'string', pattern: PATH_PATTERN } } as const;

const OPERATION_SCHEMA = {
  type: 'object',
  properties: {
    method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string', pattern: '^/' },
    query: TEMPLATE_MAP,
    body: TEMPLATE_MAP,
    success: { ...STATUSES, minItems: 1 },
    alreadyExists: STATUSES,
    conflict: STATUSES,
    items: { type: 'string', pattern: PATH_PATTERN },
    result: PATHS,
  },
  required: ['method', 'path', 'success', 'result'],
  additionalProperties: false,
} as const;

const DESCRIPTOR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    auth: {
      type: 'object',
      properties: { header: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9-]*$' }, prefix: { type: 'string' } },
      required: ['header', 'prefix'],
      additionalProperties: false,
    },
    operations: {
      type: 'object',
      properties: Object.fromEntries(FORGE_VOCABULARY.map((name) => [name, OPERATION_SCHEMA])),
      required: [...FORGE_VOCABULARY],
      additionalProperties: false,
    },
  },
  required: ['id', 'auth', 'operations'],
  additionalProperties: false,
} as const;

const validateDescriptor = defineProductSchema<ForgeDescriptor>('tools/forge-descriptor', DESCRIPTOR_SCHEMA);

export const parseForgeDescriptor = (value: unknown): ForgeDescriptor => {
  const verdict = validateDescriptor(value);
  if (verdict.valid) return verdict.value;
  const first = verdict.errors[0];
  const additional = first?.keyword === 'additionalProperties' ? `/${String(first.params['additionalProperty'])}` : '';
  throw new ForgeDescriptorError(`invalid forge descriptor at ${first?.instancePath ?? ''}${additional}: ${first?.message ?? 'schema violation'}`);
};

const DESCRIPTOR_DATA: readonly unknown[] = [github];

export const loadForgeDescriptors = (): ForgeDescriptor[] => DESCRIPTOR_DATA.map(parseForgeDescriptor);
