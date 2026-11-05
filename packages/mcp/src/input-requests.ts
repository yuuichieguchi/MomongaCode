import { isRecord } from '@momonga/foundation';
import { SchemaValidatorFailure, validateUntrusted } from '@momonga/foundation';
import { sanitizeSchema } from './schema-sanitizer.ts';
import { capText, sanitizeServerText } from './text.ts';

const MAX_ELICITATION_MESSAGE_CHARS = 2000;
const ELICITATION_METHOD = 'elicitation/create';

export type ElicitationRequest =
  | { key: string; mode: 'form'; message: string; requestedSchema: Record<string, unknown> }
  | { key: string; mode: 'url'; message: string; url: string };

export type ElicitationContentValue = string | number | boolean | string[];

export type ElicitationAnswer = { action: 'accept'; content?: Record<string, ElicitationContentValue> } | { action: 'decline' } | { action: 'cancel' };

export class McpInputProtocolError extends Error {
  cancelFailure?: unknown;

  constructor(message: string) {
    super(message);
    this.name = 'McpInputProtocolError';
  }
}

export class McpElicitationAnswerError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = 'McpElicitationAnswerError';
    this.key = key;
  }
}


const parseUrl = (key: string, raw: unknown): string => {
  if (typeof raw !== 'string') throw new McpInputProtocolError(`input request "${key}" is a url elicitation without a url`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpInputProtocolError(`input request "${key}" carries a url that is not an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpInputProtocolError(`input request "${key}" carries a ${parsed.protocol} url; only http and https can be opened`);
  }
  return parsed.href;
};

const parseEntry = (key: string, entry: unknown): ElicitationRequest => {
  if (!isRecord(entry) || typeof entry['method'] !== 'string') throw new McpInputProtocolError(`input request "${key}" is not a request object`);
  if (entry['method'] !== ELICITATION_METHOD) {
    throw new McpInputProtocolError(`input request "${key}" asks for ${entry['method']}, which this client did not declare support for`);
  }
  const params = entry['params'];
  if (!isRecord(params) || typeof params['message'] !== 'string') throw new McpInputProtocolError(`input request "${key}" has no message`);
  const message = capText(sanitizeServerText(params['message']), MAX_ELICITATION_MESSAGE_CHARS);
  const mode = params['mode'] ?? 'form';
  if (mode === 'url') return { key, mode, message, url: parseUrl(key, params['url']) };
  if (mode !== 'form') throw new McpInputProtocolError(`input request "${key}" uses the unsupported elicitation mode ${JSON.stringify(mode)}`);
  const schema = params['requestedSchema'];
  if (!isRecord(schema)) throw new McpInputProtocolError(`input request "${key}" is a form elicitation without a requestedSchema`);
  return { key, mode, message, requestedSchema: sanitizeSchema(schema) };
};

export const parseInputRequests = (inputRequests: unknown): ElicitationRequest[] => {
  if (!isRecord(inputRequests)) throw new McpInputProtocolError('inputRequests is not an object');
  return Object.entries(inputRequests).map(([key, entry]) => parseEntry(key, entry));
};

const isContentValue = (value: unknown): value is ElicitationContentValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

export const parseElicitationAnswer = (key: string, value: unknown): ElicitationAnswer => {
  if (!isRecord(value)) throw new McpElicitationAnswerError(key, `the answer for "${key}" is not an object`);
  const { action } = value;
  if (action === 'decline' || action === 'cancel') {
    if (value['content'] !== undefined) throw new McpElicitationAnswerError(key, `a ${action} answer for "${key}" must not carry content`);
    return { action };
  }
  if (action !== 'accept') throw new McpElicitationAnswerError(key, `the answer for "${key}" has action ${JSON.stringify(action)}; expected accept, decline or cancel`);
  const { content } = value;
  if (content === undefined) return { action };
  if (!isRecord(content) || !Object.values(content).every(isContentValue)) {
    throw new McpElicitationAnswerError(key, `the content for "${key}" must map names to strings, numbers, booleans or string arrays`);
  }
  return { action, content: content as Record<string, ElicitationContentValue> };
};

const validateAgainst = (server: string, request: ElicitationRequest, answer: ElicitationAnswer): void => {
  if (answer.action !== 'accept') return;
  if (request.mode === 'url') {
    if (answer.content !== undefined) throw new McpElicitationAnswerError(request.key, `an accepted url elicitation "${request.key}" must not carry content`);
    return;
  }
  if (answer.content === undefined) throw new McpElicitationAnswerError(request.key, `an accepted form elicitation "${request.key}" must carry content`);
  const verdict = validateUntrusted(`mcp-elicitation\u0000${server}\u0000${request.key}`, request.requestedSchema, answer.content);
  if (!verdict.valid) {
    const detail = verdict.errors.map((error) => `${error.instancePath || '(root)'} ${error.message ?? error.keyword}`).join('; ');
    throw new McpElicitationAnswerError(request.key, `the content for "${request.key}" does not match the requested schema: ${detail}`);
  }
};

export const parseElicitationAnswers = (
  requests: readonly ElicitationRequest[],
  raw: unknown,
  options: { server: string; onValidatorFailure(request: ElicitationRequest, message: string): void },
): Record<string, ElicitationAnswer> => {
  if (!isRecord(raw)) throw new McpElicitationAnswerError('', 'responses must be an object keyed by request key');
  const known = new Set(requests.map((request) => request.key));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new McpElicitationAnswerError(key, `"${key}" is not an outstanding request key`);
  }
  const answers: Record<string, ElicitationAnswer> = {};
  for (const request of requests) {
    if (!(request.key in raw)) throw new McpElicitationAnswerError(request.key, `no answer was given for "${request.key}"`);
    const answer = parseElicitationAnswer(request.key, raw[request.key]);
    try {
      validateAgainst(options.server, request, answer);
      answers[request.key] = answer;
    } catch (error) {
      if (!(error instanceof SchemaValidatorFailure)) throw error;
      options.onValidatorFailure(request, error.message);
      answers[request.key] = { action: 'decline' };
    }
  }
  return answers;
};
