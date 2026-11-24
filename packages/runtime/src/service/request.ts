import { JsonDepthError, defineProductSchema, parseOutsideJson } from '@momonga/foundation';
import type { ProductValidator, SandboxNetworkSetting, UntrustedError } from '@momonga/foundation';
import { PATTERN_RULES, RUN_API_SCHEMAS, runApiSchemaName } from '@momonga/protocol';
import type { ImageAttachment, InboxDelivery, JsonSchema, OutputStyle, PermissionMode, Mandate, ReasoningEffort } from '@momonga/protocol';
import { bodyTooLarge, invalidRequest, unsupportedMediaType } from './errors.ts';

export type CreateSessionBody = {
  cwd: string;
  env: Record<string, string>;
  permissionMode?: PermissionMode;
  model?: string;
  bypassAllowed?: boolean;
  sandboxNetwork?: SandboxNetworkSetting;
  mcpServers?: Record<string, Record<string, unknown>>;
  terminalUi?: boolean;
  effort?: ReasoningEffort;
  outputStyle?: OutputStyle;
};

export type PatchSessionBody = { permissionMode?: PermissionMode; model?: string; mcpServers?: Record<string, Record<string, unknown>>; effort?: ReasoningEffort | null; outputStyle?: OutputStyle | null };

export type CreateRunBody = {
  input: string;
  limits?: { maxSteps?: number; maxTotalTokens?: number; approvalTtlMs?: number; loopThreshold?: number; maxCostUsd?: number; maxFailedAttempts?: number };
  timeoutMs?: number;
  history?: 'inherit' | 'fresh';
  skill?: string;
  images?: ImageAttachment[];
  attachMentions?: boolean;
  mandate?: Mandate;
  issue?: { url: string; once?: boolean };
};

export type ResolveApprovalBody = { optionId: string };

export type AddInboxBody = { delivery: InboxDelivery; text: string; images?: ImageAttachment[]; attachMentions?: boolean };

export type ResolveElicitationBody = { responses: Record<string, unknown> };

export type PutTrustBody = { path: string; decision: 'trusted' | 'untrusted' };

export type McpFolderBody = { cwd: string; env: Record<string, string> };

type RequestSchemaName =
  | 'CreateSessionRequest'
  | 'PatchSessionRequest'
  | 'CreateRunRequest'
  | 'ResolveApprovalRequest'
  | 'AddInboxRequest'
  | 'UserShellRequest'
  | 'CompactSessionRequest'
  | 'ResolveElicitationRequest'
  | 'PutTrustRequest'
  | 'McpFolderRequest'
  | 'AddRuleRequest'
  | 'PolicyVerifyRequest'
  | 'PromoteMemoryRequest'
  | 'MarkMemoryJudgementsShownRequest'
  | 'AddMemoryRequest'
  | 'AdoptGuidelineRequest'
  | 'RecordContextChargeRequest';

const requestValidator = (schema: JsonSchema): ProductValidator<unknown> => defineProductSchema(`run-api/${runApiSchemaName(schema)}`, schema);

const validators: Record<RequestSchemaName, ProductValidator<unknown>> = {
  CreateSessionRequest: requestValidator(RUN_API_SCHEMAS.CreateSessionRequest),
  PatchSessionRequest: requestValidator(RUN_API_SCHEMAS.PatchSessionRequest),
  CreateRunRequest: requestValidator(RUN_API_SCHEMAS.CreateRunRequest),
  ResolveApprovalRequest: requestValidator(RUN_API_SCHEMAS.ResolveApprovalRequest),
  AddInboxRequest: requestValidator(RUN_API_SCHEMAS.AddInboxRequest),
  UserShellRequest: requestValidator(RUN_API_SCHEMAS.UserShellRequest),
  CompactSessionRequest: requestValidator(RUN_API_SCHEMAS.CompactSessionRequest),
  ResolveElicitationRequest: requestValidator(RUN_API_SCHEMAS.ResolveElicitationRequest),
  PutTrustRequest: requestValidator(RUN_API_SCHEMAS.PutTrustRequest),
  McpFolderRequest: requestValidator(RUN_API_SCHEMAS.McpFolderRequest),
  AddRuleRequest: requestValidator(RUN_API_SCHEMAS.AddRuleRequest),
  PolicyVerifyRequest: requestValidator(RUN_API_SCHEMAS.PolicyVerifyRequest),
  PromoteMemoryRequest: requestValidator(RUN_API_SCHEMAS.PromoteMemoryRequest),
  MarkMemoryJudgementsShownRequest: requestValidator(RUN_API_SCHEMAS.MarkMemoryJudgementsShownRequest),
  AddMemoryRequest: requestValidator(RUN_API_SCHEMAS.AddMemoryRequest),
  AdoptGuidelineRequest: requestValidator(RUN_API_SCHEMAS.AdoptGuidelineRequest),
  RecordContextChargeRequest: requestValidator(RUN_API_SCHEMAS.RecordContextChargeRequest),
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
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof JsonDepthError) throw invalidRequest(`the request body is too deep: ${error.message}`);
    throw invalidRequest('the request body is not valid JSON');
  }
};

const ruleOf = (error: UntrustedError): string => {
  const pattern = error.params['pattern'];
  const rule = error.keyword === 'pattern' && typeof pattern === 'string' ? PATTERN_RULES.get(pattern) : undefined;
  return rule === undefined ? error.message : `must be ${rule}`;
};

const refusalText = (errors: readonly UntrustedError[]): string =>
  errors.map((error) => (error.instancePath === '' ? `the request body ${error.message}` : `${error.instancePath} ${ruleOf(error)}`)).join(', ');

export const validateBody = <T>(name: RequestSchemaName, value: unknown): T => {
  const verdict = validators[name](value);
  if (!verdict.valid) throw invalidRequest(refusalText(verdict.errors));
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

export const integerQueryOf = (raw: string | undefined, name: string, bounds: { from: number; to: number }): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.from || value > bounds.to) throw invalidRequest(`${name} must be an integer from ${bounds.from} to ${bounds.to}`, name);
  return value;
};

export const pageLimitOf = (raw: string | undefined, pageRows: number): number => integerQueryOf(raw, 'limit', { from: 1, to: pageRows }) ?? pageRows;

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
