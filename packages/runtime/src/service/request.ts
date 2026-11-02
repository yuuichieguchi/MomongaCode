import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { RUN_API_SCHEMAS } from '@momonga/protocol';
import type { ImageAttachment, PermissionMode } from '@momonga/protocol';
import { bodyTooLarge, invalidRequest, unsupportedMediaType } from './errors.ts';

export type CreateSessionBody = {
  cwd: string;
  env: Record<string, string>;
  permissionMode?: PermissionMode;
  modelAlias?: string;
  bypassAllowed?: boolean;
  mcpServers?: Record<string, Record<string, unknown>>;
};

export type PatchSessionBody = { permissionMode?: PermissionMode; mcpServers?: Record<string, Record<string, unknown>> };

export type CreateRunBody = {
  input: string;
  limits?: { maxSteps?: number; maxTotalTokens?: number; approvalTtlMs?: number; loopThreshold?: number };
  timeoutMs?: number;
  history?: 'inherit' | 'fresh';
  skill?: string;
  images?: ImageAttachment[];
};

export type ResolveApprovalBody = { optionId: string };

export type ResolveElicitationBody = { responses: Record<string, unknown> };

export type PutTrustBody = { path: string; decision: 'trusted' | 'untrusted' };

type RequestSchemaName =
  | 'CreateSessionRequest'
  | 'PatchSessionRequest'
  | 'CreateRunRequest'
  | 'ResolveApprovalRequest'
  | 'ResolveElicitationRequest'
  | 'PutTrustRequest'
  | 'AddRuleRequest';

const ajv = new Ajv2020.default({ strict: false, allErrors: true });

const validators: Record<RequestSchemaName, ValidateFunction> = {
  CreateSessionRequest: ajv.compile(RUN_API_SCHEMAS.CreateSessionRequest),
  PatchSessionRequest: ajv.compile(RUN_API_SCHEMAS.PatchSessionRequest),
  CreateRunRequest: ajv.compile(RUN_API_SCHEMAS.CreateRunRequest),
  ResolveApprovalRequest: ajv.compile(RUN_API_SCHEMAS.ResolveApprovalRequest),
  ResolveElicitationRequest: ajv.compile(RUN_API_SCHEMAS.ResolveElicitationRequest),
  PutTrustRequest: ajv.compile(RUN_API_SCHEMAS.PutTrustRequest),
  AddRuleRequest: ajv.compile(RUN_API_SCHEMAS.AddRuleRequest),
};

export const JSON_MEDIA_TYPES = ['application/json'] as const;
export const PATCH_MEDIA_TYPES = ['application/json', 'application/merge-patch+json'] as const;

const mediaTypeOf = (header: string | null): string | undefined => header?.split(';', 1)[0]?.trim().toLowerCase();

const readBytes = async (request: Request, maxBytes: number): Promise<Uint8Array> => {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw bodyTooLarge(maxBytes);
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw bodyTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

export const readJson = async (request: Request, accepted: readonly string[], maxBytes: number): Promise<unknown> => {
  const mediaType = mediaTypeOf(request.headers.get('content-type'));
  if (mediaType === undefined || !accepted.includes(mediaType)) throw unsupportedMediaType(accepted);
  const bytes = await readBytes(request, maxBytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequest('the request body is not valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalidRequest('the request body is not valid JSON');
  }
};

export const validateBody = <T>(name: RequestSchemaName, value: unknown): T => {
  const validate = validators[name];
  if (!validate(value)) throw invalidRequest(ajv.errorsText(validate.errors, { dataVar: 'body' }));
  return value as T;
};

const VISIBLE_ASCII = /^[\x21-\x7e]{1,200}$/;

const unescapeStructuredString = (inner: string): string => {
  let result = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] as string;
    if (char === '"') throw invalidRequest('the Idempotency-Key contains an unescaped quote', 'Idempotency-Key');
    if (char !== '\\') {
      result += char;
      continue;
    }
    const escaped = inner[index + 1];
    if (escaped !== '"' && escaped !== '\\') throw invalidRequest('the Idempotency-Key has an invalid escape', 'Idempotency-Key');
    result += escaped;
    index += 1;
  }
  return result;
};

export const parseIdempotencyKey = (header: string | null): string | undefined => {
  if (header === null) return undefined;
  const raw = header.trim();
  let key: string;
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) throw invalidRequest('the Idempotency-Key string is not terminated', 'Idempotency-Key');
    key = unescapeStructuredString(raw.slice(1, -1));
  } else {
    key = raw;
  }
  if (!VISIBLE_ASCII.test(key)) {
    throw invalidRequest('the Idempotency-Key must be 1 to 200 visible ASCII characters', 'Idempotency-Key');
  }
  return key;
};

const CURSOR = /^(?:0|[1-9][0-9]*)$/;

export const parseCursor = (request: Request, max: number): number => {
  const header = request.headers.get('last-event-id');
  const param = header === null ? 'after' : 'Last-Event-ID';
  const raw = header ?? new URL(request.url).searchParams.get('after') ?? '0';
  if (!CURSOR.test(raw)) throw invalidRequest(`the event cursor must be a non-negative integer, got ${JSON.stringify(raw)}`, param);
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor > max) throw invalidRequest(`the event cursor ${raw} is beyond the last event ${max}`, param);
  return cursor;
};
