import type http from 'node:http';
import { openingEvents, openResponsesStream, terminalEvent } from './fake-open-responses.ts';
import { serveFakeUpstreamReply } from './fake-sse-upstream.ts';
import type { FakeUpstreamReply, RecordedUpstreamRequest } from './fake-sse-upstream.ts';
import { readBody, startLoopbackServer } from './loopback-http.ts';

export const PLAN_RESPONSES_PATH = '/v1/responses';

export const PLAN_MODELS_PATH = '/v1/models';

export const PLAN_ERROR_CODES = [
  { code: 'subscription_sharing_user_not_eligible', status: 403 },
  { code: 'subscription_sharing_usage_limit_exceeded', status: 429 },
  { code: 'subscription_sharing_usage_unavailable', status: 503 },
  { code: 'subscription_sharing_unsupported_capability', status: 400 },
  { code: 'subscription_sharing_route_not_supported', status: 403 },
  { code: 'subscription_sharing_invalid_user', status: 401 },
  { code: 'chatpass_v2_scope_not_authorized', status: 403 },
  { code: 'chatpass_v2_invalid_authorization_context', status: 403 },
  { code: 'subscription_sharing_user_unavailable', status: 503 },
  { code: 'subscription_sharing_workplace_individual_usage_limit_exceeded', status: null },
] as const;

export const PLAN_UNSUPPORTED_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
] as const;

export const PLAN_UNSUPPORTED_TOOL_TYPES = ['image_generation', 'file_search', 'code_interpreter', 'computer_use_preview', 'mcp', 'tool_search', 'programmatic_tool_calling'] as const;

const UNSUPPORTED_INPUT_PART_TYPES = ['input_audio', 'input_video'];

const ADMISSION_STATUSES = [401, 403, 503];

const UNSUPPORTED_CAPABILITY = 'subscription_sharing_unsupported_capability';

const ROUTE_NOT_SUPPORTED = 'subscription_sharing_route_not_supported';

export type BearerVerdict = 'valid' | 'expired' | 'revoked' | 'unknown';

export type PlanResponsesOptions = {
  verifyBearer: (token: string | undefined) => BearerVerdict;
  script?: FakeUpstreamReply[];
  respond?: (request: RecordedUpstreamRequest) => FakeUpstreamReply | undefined;
  models?: readonly unknown[];
  maxRequestBytes?: { limit: number; reply: FakeUpstreamReply };
};

export type FakePlanResponses = {
  origin: string;
  port: number;
  requests: RecordedUpstreamRequest[];
  close(): Promise<void>;
};

type ErrorReplyOptions = { status?: number; param?: string; message?: string; headers?: Record<string, string> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const entryOf = (code: string): (typeof PLAN_ERROR_CODES)[number] => {
  const entry = PLAN_ERROR_CODES.find((candidate) => candidate.code === code);
  if (entry === undefined) throw new Error(`${code} is not in the catalogue of plan error codes`);
  return entry;
};

export const planErrorHttpReply = (code: string, options: ErrorReplyOptions): FakeUpstreamReply => {
  const entry = entryOf(code);
  if (entry.status === null && options.status === undefined) throw new Error(`the pages do not state a status for ${code}: give a status`);
  if (entry.status !== null && options.status !== undefined && options.status !== entry.status) throw new Error(`${code} is documented with status ${entry.status}, not ${options.status}`);
  return {
    kind: 'error',
    status: entry.status ?? (options.status as number),
    body: { error: { code, message: options.message ?? `the fake plan route answers ${code}`, param: options.param ?? null } },
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  };
};

export const planErrorStreamReply = (code: string, options: { message?: string }): FakeUpstreamReply => {
  entryOf(code);
  return openResponsesStream([...openingEvents(), terminalEvent({ kind: 'failed', code, message: options.message ?? `the fake plan route answers ${code}` }, [])]);
};

export const planAdmissionReply = (status: number, detail: string): FakeUpstreamReply => {
  if (!ADMISSION_STATUSES.includes(status)) throw new Error(`direct admission fails with ${ADMISSION_STATUSES.join(', ')}, not ${status}`);
  return { kind: 'error', status, body: { detail } };
};

const rejection = (param: string, reason: string): FakeUpstreamReply => planErrorHttpReply(UNSUPPORTED_CAPABILITY, { param, message: reason });

const hostedToolRejection = (tools: unknown): FakeUpstreamReply | undefined => {
  if (!Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (PLAN_UNSUPPORTED_TOOL_TYPES.some((type) => type === tool['type']) || 'programmatic_tool_calling' in tool) {
      return rejection('tools', `the tool ${String(tool['type'])} is not supported on this route`);
    }
  }
  return undefined;
};

const inputRejection = (input: unknown): FakeUpstreamReply | undefined => {
  if (!Array.isArray(input)) return rejection('input', 'input must be an array');
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item['role'] === 'system') return rejection('input', 'explicit system items are rejected: use instructions or developer messages');
    if (item['type'] === 'additional_tools' && hostedToolRejection(item['tools']) !== undefined) return rejection('input', 'additional_tools carries an unsupported tool');
    const content = item['content'];
    if (Array.isArray(content) && content.some((part) => isRecord(part) && UNSUPPORTED_INPUT_PART_TYPES.includes(String(part['type'])))) {
      return rejection('input', 'audio and video input are not supported');
    }
  }
  return undefined;
};

const bodyRejection = (body: unknown): FakeUpstreamReply | undefined => {
  if (!isRecord(body)) return { kind: 'error', status: 400, body: { detail: 'the request body must be a JSON object' } };
  for (const field of PLAN_UNSUPPORTED_FIELDS) if (field in body) return rejection(field, `${field} is not supported on this route`);
  if ('previous_response_id' in body) return rejection('previous_response_id', 'previous_response_id is not supported over HTTP');
  if (body['store'] !== false) return rejection('store', 'store must be false');
  if (body['stream'] !== true) return rejection('stream', 'stream must be true');
  return inputRejection(body['input']) ?? hostedToolRejection(body['tools']);
};

const parsedBody = (raw: string): { parsed: unknown } | { invalid: true } => {
  if (raw === '') return { parsed: undefined };
  try {
    return { parsed: JSON.parse(raw) as unknown };
  } catch {
    return { invalid: true };
  }
};

const bearerOf = (headers: http.IncomingHttpHeaders): string | undefined => {
  const header = headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
};

export const startFakePlanResponses = async (options: PlanResponsesOptions): Promise<FakePlanResponses> => {
  const requests: RecordedUpstreamRequest[] = [];
  const script = [...(options.script ?? [])];
  const verify = options.verifyBearer;
  const models = options.models ?? [];

  const loopback = await startLoopbackServer(async (req, res) => {
    const raw = await readBody(req);
    const outcome = parsedBody(raw);
    const recorded: RecordedUpstreamRequest = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      body: 'invalid' in outcome ? raw : outcome.parsed,
    };
    requests.push(recorded);
    if (verify(bearerOf(req.headers)) !== 'valid') {
      await serveFakeUpstreamReply(planAdmissionReply(401, 'the bearer token was not accepted'), res);
      return;
    }
    if (recorded.method === 'GET' && recorded.path === PLAN_MODELS_PATH) {
      await serveFakeUpstreamReply({ kind: 'json', body: { models } }, res);
      return;
    }
    if (recorded.method !== 'POST' || recorded.path !== PLAN_RESPONSES_PATH) {
      await serveFakeUpstreamReply(planErrorHttpReply(ROUTE_NOT_SUPPORTED, { message: `only POST ${PLAN_RESPONSES_PATH} is served` }), res);
      return;
    }
    if (options.maxRequestBytes !== undefined && Buffer.byteLength(raw) > options.maxRequestBytes.limit) {
      await serveFakeUpstreamReply(options.maxRequestBytes.reply, res);
      return;
    }
    const rejected = 'invalid' in outcome ? ({ kind: 'error', status: 400, body: { detail: 'the request body is not valid JSON' } } as const) : bodyRejection(outcome.parsed);
    if (rejected !== undefined) {
      await serveFakeUpstreamReply(rejected, res);
      return;
    }
    const reply = options.respond === undefined ? script.shift() : options.respond(recorded);
    await serveFakeUpstreamReply(reply ?? { kind: 'error', status: 500, body: { error: { message: 'the fake plan route has no scripted reply left' } } }, res);
  });

  return { origin: loopback.origin, port: loopback.port, requests, close: () => loopback.close() };
};
