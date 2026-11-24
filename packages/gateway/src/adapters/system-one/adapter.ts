import { isRecord } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { cachedDetailOf, isUnavailableCapabilities, modelJobRefusal } from '@momonga/protocol';
import type {
  AdapterContext,
  AdapterInputItem,
  AdapterRequest,
  AdapterTarget,
  Capabilities,
  ProviderAdapter,
  StreamEvent,
  ToolChoiceWire,
  Usage,
} from '@momonga/protocol';
import { unavailableError } from '../../core/unavailable.ts';
import { CHAT_COMPLETIONS_VOCABULARY } from '../chat-completions/vocabulary.ts';
import { afterCredentialEffect, sendAuthorized } from '../shared/auth.ts';
import type { AdapterAuth } from '../shared/auth.ts';
import { readTextLimited } from '../shared/body-reading.ts';
import { createUpstreamClassifier } from '../shared/classify.ts';
import { UnsupportedInputError } from '../shared/failures.ts';
import { createEndpointPool, routeReportOf } from '../shared/http-client.ts';
import type { UpstreamEndpoint, UpstreamLiveness } from '../shared/http-client.ts';
import { httpErrorOf, nestedErrorDetail, retryAfterHint } from '../shared/http-error.ts';
import { MAX_RESPONSE_TEXT_CHARS } from '../shared/limits.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';
import { usableUpstreamJson } from '../shared/upstream-json.ts';

const SYSTEM_ONE_PROVIDER_LABEL = 'system-one';
const SYSTEM_ONE_PATH = '/systemone';
const NO_TOOL_CHOICE: ToolChoiceWire = { forms: [], expressesRequired: false };

export type SystemOneAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget, signal: AbortSignal) => Promise<UpstreamEndpoint>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  authSource: AdapterAuth;
  clock: Clock;
  liveness: UpstreamLiveness;
};

const stateTextOf = (input: readonly AdapterInputItem[]): string => {
  const parts: string[] = [];
  for (const item of input) {
    if (item.type !== 'message') continue;
    if (typeof item.content === 'string') {
      parts.push(item.content);
      continue;
    }
    for (const part of item.content) {
      if (part.type === 'input_text' || part.type === 'output_text') parts.push(part.text);
    }
  }
  return parts.join('\n');
};

const nonNegInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const usageOf = (raw: unknown): Usage | null => {
  if (!isRecord(raw)) return null;
  const inputTokens = nonNegInt(raw['input_tokens']);
  const outputTokens = nonNegInt(raw['output_tokens']);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const details = isRecord(raw['input_tokens_details']) ? raw['input_tokens_details'] : undefined;
  const cachedTokens = details === undefined ? undefined : nonNegInt(details['cached_tokens']);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: cachedDetailOf(cachedTokens),
    output_tokens_details: { reasoning_tokens: 0 },
  };
};

type ParsedSystemOne = {
  usage: Usage | null;
  refusal?: string;
  choices?: Record<string, string>;
};

const parseSystemOneReply = (text: string, askedKeys: readonly string[]): ParsedSystemOne => {
  const parsed = usableUpstreamJson(text);
  if (!isRecord(parsed)) return { usage: null };
  const usage = usageOf(parsed['usage']);
  const answers = parsed['answers'];
  if (!isRecord(answers)) return { usage };
  const choices: Record<string, string> = {};
  for (const key of askedKeys) {
    const entry = answers[key];
    if (!isRecord(entry)) continue;
    if (entry['type'] === 'refusal') {
      const msg = typeof entry['message'] === 'string' && entry['message'] !== '' ? entry['message'] : 'refused';
      return { usage, refusal: msg };
    }
    if (entry['type'] === 'choice' && typeof entry['choice'] === 'string') {
      choices[key] = entry['choice'];
    }
  }
  return { usage, choices };
};

export const createSystemOneAdapter = (options: SystemOneAdapterOptions): ProviderAdapter => {
  const pool = createEndpointPool({ label: SYSTEM_ONE_PROVIDER_LABEL, unixPath: SYSTEM_ONE_PATH, urlSuffix: SYSTEM_ONE_PATH }, options.liveness);
  const classify = createUpstreamClassifier(SYSTEM_ONE_PROVIDER_LABEL);
  let closing: Promise<void> | undefined;
  let closed = false;

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the system-one adapter is closed');
    const capabilities = ctx.capabilities;
    if (isUnavailableCapabilities(capabilities)) throw unavailableError(capabilities.toolCalling);
    if (request.choices === undefined) {
      throw new UnsupportedInputError('unsupported_request', modelJobRefusal(ctx.target.display, 'session'), 'model');
    }
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    try {
      const endpoint = await options.resolveEndpoint(ctx.target, signal);
      const auth = options.authSource(ctx.target);
      const body = JSON.stringify({
        model: request.model,
        state: stateTextOf(request.input),
        questions: request.choices.questions,
      });
      const response = await sendAuthorized(auth, signal, (bearer) =>
        pool.clientFor(endpoint).post({
          ...routeReportOf(ctx),
          headers: {
            'content-type': 'application/json',
            accept: '*/*',
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          },
          body,
          signal,
        }),
      );
      if (response.status !== 200) {
        const failure = await httpErrorOf(response, options.clock, nestedErrorDetail, CHAT_COMPLETIONS_VOCABULARY);
        throw await afterCredentialEffect(failure, auth, classify(failure), options.clock, signal);
      }
      const rawText = await readTextLimited(response.body, MAX_RESPONSE_TEXT_CHARS);
      const askedKeys = Object.keys(request.choices.questions);
      const reply = parseSystemOneReply(rawText.text, askedKeys);
      const emitter = new ResponseEmitter({
        clock: options.clock,
        model: request.model,
        request,
        signal: ctx.signal,
        jsonReply: 'enforced',
        ...retryAfterHint(response, options.clock),
      });
      emitter.start();
      if (reply.refusal !== undefined) {
        emitter.appendRefusal(reply.refusal);
      } else {
        emitter.appendText(JSON.stringify(reply.choices ?? {}));
      }
      await emitter.complete(reply.usage ?? undefined);
      for (const event of emitter.take()) {
        ctx.signal.throwIfAborted();
        yield event;
      }
    } finally {
      upstream.abort();
    }
  }

  return {
    kind: SYSTEM_ONE_PROVIDER_LABEL,
    sampling: { renders: [] },
    relaysClientBody: [],
    capabilities: (target) => options.capabilities(target),
    create,
    classify,
    toolChoiceWire: () => NO_TOOL_CHOICE,
    close: () => {
      closed = true;
      closing ??= pool.close();
      return closing;
    },
  };
};
