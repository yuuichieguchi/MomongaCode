import { defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { PROBE_KEYWORDS } from '@momonga/protocol';
import type { ConstructResult, ConstructSupport, DialectId, ProbeDialectAttempt, ProbeDialectResult, ProbeKeyword, ProbeReportDialect } from '@momonga/protocol';
import { isAcceptedEnvelope } from '../adapters/chat-completions/constrained-sink.ts';
import { upstreamErrorMessage } from '../adapters/chat-completions/upstream-reply.ts';
import { candidateIds } from '../dialect/candidates.ts';
import { resolveDialect } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import type { KeywordSupport } from '../dialect/keyword-support.ts';
import { RenderLedger } from '../dialect/ledger.ts';
import { SchemaRenderError, renderSchema } from '../dialect/render.ts';
import type { ResolvedDialect } from '../dialect/render.ts';
import { renderToolParameters } from '../dialect/tool-render.ts';
import { invertReply } from '../dialect/unwrap.ts';
import { DEFAULT_MIN_VALID_RATE, atLeast } from './decide.ts';
import {
  CONSTRUCT_NAMES,
  CONSTRUCT_TOOLS,
  DEMANDING_PROMPT,
  FORECAST_TOOL,
  SELECTION_TOOLS,
  NEUTRAL_PROMPT,
  SELECTION_SYSTEM_PROMPT,
  originalEnvelope,
  selectionEnvelope,
  selectionToolSpecs,
} from './dialect-probe-schema.ts';
import type { ConstructName } from './dialect-probe-schema.ts';
import { keywordProbeSchemas } from './envelope.ts';
import type { EnvelopeShape } from './envelope.ts';
import { field, isRecord, parseJson } from './json.ts';
import { assistantMessage, failProbeStep, isAcceptedOrRejected, sampleRequest } from './probe-chat.ts';
import type { Chat, ChatResult } from './probe-chat.ts';

export type SelectionReply = { kind: 'ok'; content: string | undefined } | { kind: 'absent' } | { kind: 'refused'; detail: string };

export type SelectionRequest =
  | { kind: 'neutral'; schema: unknown }
  | { kind: 'demanding'; schema: unknown }
  | { kind: 'tools'; tools: unknown[] }
  | { kind: 'construct-format'; schema: unknown }
  | { kind: 'construct-tools'; tools: unknown[] };

export type SelectionTransport = {
  legs: { responseFormat: boolean; tools: boolean };
  request: (request: SelectionRequest) => Promise<SelectionReply | undefined>;
};

export type DialectSelectionOptions = { transport: SelectionTransport; samples: number; userDialects: UserDialects; declaredDialect: DialectId | undefined };

export type DialectSelection = {
  dialect: ProbeReportDialect;
  constrained: { accepted: boolean; validRate: number };
  legs: Legs;
};

const ENVELOPE_VALIDATORS: Record<EnvelopeShape, ProductValidator<unknown>> = {
  union: defineProductSchema('gateway/probe-envelope-union', originalEnvelope('union')),
  flat: defineProductSchema('gateway/probe-envelope-flat', originalEnvelope('flat')),
};

const validateForecastArguments: ProductValidator<unknown> = defineProductSchema('gateway/probe-forecast-arguments', FORECAST_TOOL.parameters ?? {});

const ABSENT_STATUSES: readonly number[] = [404, 501];

const refusalDetail = (result: ChatResult): string => (result.reply.kind === 'error' ? upstreamErrorMessage(result.reply.body) : result.text.slice(0, 500));

const namesUnknownParameter = (result: ChatResult, parameter: string): boolean => {
  if (ABSENT_STATUSES.includes(result.status)) return true;
  if (result.status < 400 || result.status >= 500) return false;
  const error = field(result.reply.body, 'error');
  return field(error, 'param') === parameter && (field(error, 'code') ?? null) === null;
};

const LEG_PARAMETER: Record<SelectionRequest['kind'], string> = {
  neutral: 'response_format',
  demanding: 'response_format',
  'construct-format': 'response_format',
  tools: 'tools',
  'construct-tools': 'tools',
};

export const screened = (result: ChatResult, what: string, parameter: string): SelectionReply => {
  if (namesUnknownParameter(result, parameter)) return { kind: 'absent' };
  if (result.outcome === 'accepted') {
    const content = field(assistantMessage(result.reply.body), 'content');
    return { kind: 'ok', content: typeof content === 'string' ? content : undefined };
  }
  if (result.outcome === 'unsupported' || (result.status >= 400 && result.status < 500)) return { kind: 'refused', detail: refusalDetail(result) };
  return failProbeStep(result, what);
};

const responseFormatOf = (schema: unknown): unknown => ({ type: 'json_schema', json_schema: { name: 'probe', strict: true, schema } });

export const chatTransport = (chat: Chat, legs: Legs): SelectionTransport => ({
  legs,
  request: async (request) => {
    const result = await sampleRequest(chat, bodyOf(request));
    return result === undefined ? undefined : screened(result, `dialect ${request.kind}`, LEG_PARAMETER[request.kind]);
  },
});

export const messagesOf = (request: SelectionRequest): { role: string; content: string }[] =>
  request.kind === 'demanding'
    ? [
        { role: 'system', content: SELECTION_SYSTEM_PROMPT },
        { role: 'user', content: DEMANDING_PROMPT },
      ]
    : [{ role: 'user', content: NEUTRAL_PROMPT }];

const bodyOf = (request: SelectionRequest): Record<string, unknown> => {
  switch (request.kind) {
    case 'neutral':
    case 'demanding':
    case 'construct-format':
      return { messages: messagesOf(request), response_format: responseFormatOf(request.schema) };
    case 'tools':
    case 'construct-tools':
      return { messages: messagesOf(request), tools: request.tools };
  }
};

const argumentsInverted = (call: unknown, ledger: RenderLedger): unknown => {
  if (!isRecord(call)) return call;
  const name = call['name'];
  const record = typeof name === 'string' ? ledger.wraps.get(name) : undefined;
  if (record === undefined) return call;
  return { ...call, arguments: parseJson(invertReply(record, JSON.stringify(call['arguments']))) };
};

const SELECTION_PLAN = { toolNames: new Set(SELECTION_TOOLS.map((tool) => tool.name)), requireToolCalls: false };

const replyEnvelope = (reply: SelectionReply | undefined, ledger: RenderLedger): Record<string, unknown> | undefined => {
  if (reply?.kind !== 'ok' || reply.content === undefined || !isAcceptedEnvelope(reply.content, SELECTION_PLAN)) return undefined;
  const envelope = parseJson(reply.content);
  if (!isRecord(envelope)) return undefined;
  const calls = envelope['calls'];
  return Array.isArray(calls) ? { ...envelope, calls: calls.map((call) => argumentsInverted(call, ledger)) } : envelope;
};

const neutralValid = (reply: SelectionReply | undefined, ledger: RenderLedger, shape: EnvelopeShape): boolean => {
  const envelope = replyEnvelope(reply, ledger);
  return envelope !== undefined && ENVELOPE_VALIDATORS[shape](envelope).valid;
};

const demandingValid = (reply: SelectionReply | undefined, ledger: RenderLedger, shape: EnvelopeShape): boolean => {
  const envelope = replyEnvelope(reply, ledger);
  if (envelope === undefined || !ENVELOPE_VALIDATORS[shape](envelope).valid || envelope['kind'] !== 'tool_calls') return false;
  const calls = envelope['calls'];
  const call: unknown = Array.isArray(calls) ? calls[0] : undefined;
  return isRecord(call) && call['name'] === FORECAST_TOOL.name && validateForecastArguments(call['arguments']).valid;
};

export type Legs = { responseFormat: boolean; tools: boolean };

type Attempt = { result: ProbeDialectResult; detail?: string; constrainedRate?: number };

type Sampled = { rate: number; valid: number; sent: number; refusal?: string };

const sampleRate = async (
  samples: number,
  send: () => Promise<SelectionReply | undefined>,
  valid: (reply: SelectionReply | undefined) => boolean,
  first?: SelectionReply | undefined,
): Promise<Sampled> => {
  const tolerated = samples - Math.ceil(samples * DEFAULT_MIN_VALID_RATE - 1e-9);
  let validCount = 0;
  let invalidCount = 0;
  for (let index = 0; index < samples; index += 1) {
    const reply = index === 0 && first !== undefined ? first : await send();
    if (index === 0 && reply?.kind === 'refused') return { rate: 0, valid: 0, sent: 1, refusal: reply.detail };
    if (index === 0 && reply?.kind === 'absent') return { rate: 0, valid: 0, sent: 1, refusal: 'the server answered with an unavailable route' };
    if (valid(reply)) validCount += 1;
    else invalidCount += 1;
    if (invalidCount > tolerated) return { rate: validCount / samples, valid: validCount, sent: index + 1 };
  }
  return { rate: samples === 0 ? 0 : validCount / samples, valid: validCount, sent: samples };
};

const tryCandidate = async (options: DialectSelectionOptions, resolved: ResolvedDialect, shape: EnvelopeShape, legs: Legs): Promise<Attempt> => {
  const { transport, samples } = options;
  const ledger = new RenderLedger();
  let envelope: unknown;
  let toolSpecs: unknown[];
  try {
    envelope = selectionEnvelope(resolved, shape, ledger);
    toolSpecs = selectionToolSpecs(resolved, ledger);
  } catch (error) {
    if (error instanceof SchemaRenderError) return { result: 'unrenderable', detail: error.message };
    throw error;
  }
  const sendNeutral = (): Promise<SelectionReply | undefined> => transport.request({ kind: 'neutral', schema: envelope });
  let firstNeutral: SelectionReply | undefined;
  if (legs.responseFormat) {
    firstNeutral = await sendNeutral();
    if (firstNeutral === undefined) throw new Error('Probe step "dialect screen" timed out on its first sample');
    if (firstNeutral.kind === 'refused') return { result: 'refused', detail: firstNeutral.detail };
    if (firstNeutral.kind === 'absent') legs.responseFormat = false;
  }
  if (legs.tools) {
    const toolsScreen = await transport.request({ kind: 'tools', tools: toolSpecs });
    if (toolsScreen === undefined) throw new Error('Probe step "dialect tools screen" timed out');
    if (toolsScreen.kind === 'refused') return { result: 'refused', detail: toolsScreen.detail };
    if (toolsScreen.kind === 'absent') legs.tools = false;
  }
  if (!legs.responseFormat && !legs.tools) return { result: 'refused', detail: 'the server reported both legs as unsupported' };
  if (!legs.responseFormat) return { result: 'accepted' };

  const neutral = await sampleRate(samples, sendNeutral, (reply) => neutralValid(reply, ledger, shape), firstNeutral);
  if (neutral.refusal !== undefined) return { result: 'refused', detail: neutral.refusal };
  if (!atLeast(neutral.rate, DEFAULT_MIN_VALID_RATE)) {
    return { result: 'not-enforced', detail: `a neutral reply validated against the original schema in ${neutral.valid} of ${neutral.sent} samples sent, which cannot reach the required share of ${samples}` };
  }
  const demanding = await sampleRate(samples, () => transport.request({ kind: 'demanding', schema: envelope }), (reply) => demandingValid(reply, ledger, shape));
  if (demanding.refusal !== undefined) return { result: 'refused', detail: demanding.refusal };
  if (!atLeast(demanding.rate, DEFAULT_MIN_VALID_RATE)) {
    return { result: 'not-enforced', detail: `a reply to the demanding prompt validated against the original schema in ${demanding.valid} of ${demanding.sent} samples sent, which cannot reach the required share of ${samples}`, constrainedRate: demanding.rate };
  }
  return { result: 'accepted', constrainedRate: demanding.rate };
};

const RESULT_RANK: Record<ProbeDialectResult, number> = { unrenderable: 0, refused: 1, 'not-enforced': 2, accepted: 3 };

export const selectDialect = async (options: DialectSelectionOptions): Promise<DialectSelection> => {
  const ids = candidateIds(options.userDialects, options.declaredDialect);
  const legs: Legs = { ...options.transport.legs };
  const tried = new Map<DialectId, ProbeDialectAttempt>();
  for (const shape of ['union', 'flat'] as const) {
    if (!legs.responseFormat) break;
    for (const id of ids) {
      const resolved = resolveDialect(id, options.userDialects);
      const attempt = await tryCandidate(options, resolved, shape, legs);
      const entry: ProbeDialectAttempt = { id, result: attempt.result, ...(attempt.detail === undefined ? {} : { detail: attempt.detail }) };
      const earlier = tried.get(id);
      if (earlier === undefined || RESULT_RANK[attempt.result] > RESULT_RANK[earlier.result]) tried.set(id, entry);
      if (!legs.responseFormat && !legs.tools) return { dialect: { selected: null, shape: null, tried: [...tried.values()] }, constrained: { accepted: false, validRate: 0 }, legs };
      if (attempt.result === 'accepted') {
        return {
          dialect: { selected: id, shape, tried: [...tried.values()] },
          constrained: legs.responseFormat ? { accepted: true, validRate: attempt.constrainedRate ?? 0 } : { accepted: false, validRate: 0 },
          legs,
        };
      }
    }
  }
  return { dialect: { selected: null, shape: null, tried: [...tried.values()] }, constrained: { accepted: false, validRate: 0 }, legs };
};

export const probeKeywords = async (chat: Chat, resolved: ResolvedDialect): Promise<KeywordSupport> => {
  const support = Object.fromEntries(PROBE_KEYWORDS.map((keyword) => [keyword, false])) as KeywordSupport;
  for (const keyword of PROBE_KEYWORDS) support[keyword] = await probeKeyword(chat, keyword, resolved);
  return support;
};

const probeKeyword = async (chat: Chat, keyword: ProbeKeyword, resolved: ResolvedDialect): Promise<boolean> =>
  isAcceptedOrRejected(
    await chat({
      messages: [{ role: 'user', content: NEUTRAL_PROMPT }],
      response_format: responseFormatOf(renderSchema(keywordProbeSchemas[keyword], { kind: 'probe' }, resolved).schema),
    }),
    `keyword ${keyword}`,
  );

const probeConstruct = async (transport: SelectionTransport, name: ConstructName, resolved: ResolvedDialect, legs: Legs): Promise<ConstructResult> => {
  const tool = CONSTRUCT_TOOLS[name];
  let rendered: unknown;
  try {
    rendered = renderToolParameters(tool, resolved).schema;
  } catch (error) {
    if (error instanceof SchemaRenderError) return 'unrenderable';
    throw error;
  }
  const replies: (SelectionReply | undefined)[] = [];
  if (legs.responseFormat) replies.push(await transport.request({ kind: 'construct-format', schema: rendered }));
  if (legs.tools) {
    replies.push(await transport.request({ kind: 'construct-tools', tools: [{ type: 'function', function: { name: tool.name, description: 'A probe tool', parameters: rendered } }] }));
  }
  return replies.some((reply) => reply?.kind === 'refused') ? 'refused' : 'accepted';
};

export const probeConstructs = async (transport: SelectionTransport, resolved: ResolvedDialect, legs: Legs): Promise<ConstructSupport> => {
  const results: Partial<Record<ConstructName, ConstructResult>> = {};
  for (const name of CONSTRUCT_NAMES) results[name] = await probeConstruct(transport, name, resolved, legs);
  return results as ConstructSupport;
};
