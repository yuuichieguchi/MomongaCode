import { DEFAULT_DIALECT_ID, DEFAULT_SYSTEM_ROLE, DEFAULT_TOOL_PLACEMENT, acceptedReasoningEfforts, clampReasoningEffort, compactionSummaryMessage, outputTokensFor } from '@momonga/protocol';
import type { AdapterInputItem, AdapterRequest, Capabilities, ContentPart, DialectId, FunctionTool, InputItem, OutputTokenCapabilities, ReasoningEffort, ReasoningOrigin, SystemRole, ToolPlacement } from '@momonga/protocol';
import { NO_USER_DIALECTS, resolveDialect } from '../../dialect/choice.ts';
import type { UserDialects } from '../../dialect/choice.ts';
import { RenderLedger } from '../../dialect/ledger.ts';
import type { ResolvedDialect } from '../../dialect/render.ts';
import { renderToolParameters } from '../../dialect/tool-render.ts';
import { isJsonOnlyEnforced, jsonReplyFormatOf } from '../shared/json-reply.ts';
import type { JsonReplyPlan } from '../shared/json-reply.ts';
import { callArgumentsText } from '../shared/call-arguments.ts';
import { UnsupportedInputError } from '../shared/failures.ts';
import { imageUrlOf, isImagePart } from '../shared/image-part.ts';
import { ownReasoning } from '../shared/reasoning-origin.ts';
import { carriedSamplingOf } from '../shared/sampling.ts';

export type AdditionalToolsItem = { type: 'additional_tools'; role: 'developer'; tools: FunctionTool[] };

export const OPEN_RESPONSES_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly ReasoningEffort[];

export type OpenResponsesReasoningEffort = (typeof OPEN_RESPONSES_REASONING_EFFORTS)[number];

export type OpenResponsesRequestBody = {
  [unknownField: string]: unknown;
  model: string;
  input: Array<InputItem | AdditionalToolsItem>;
  stream: true;
  store: false;
  include: ['reasoning.encrypted_content'];
  instructions?: string;
  tools?: AdapterRequest['tools'];
  tool_choice?: AdapterRequest['tool_choice'];
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort: OpenResponsesReasoningEffort };
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  prompt_cache_key?: string;
};

const TEXT_PART_TYPES: ReadonlySet<ContentPart['type']> = new Set(['input_text', 'output_text', 'summary_text', 'refusal']);

const relayable = (content: string | ContentPart[], allowed: ReadonlySet<ContentPart['type']>): string | ContentPart[] => {
  if (typeof content === 'string') return content;
  for (const part of content) {
    if (!allowed.has(part.type)) {
      throw new UnsupportedInputError('unsupported_input', `the upstream adapter does not support ${part.type} content here`, 'input');
    }
    if (isImagePart(part)) imageUrlOf(part);
  }
  return content;
};

const USER_PART_TYPES: ReadonlySet<ContentPart['type']> = new Set([...TEXT_PART_TYPES, 'input_image']);

const itemOf = (item: AdapterInputItem, origin: ReasoningOrigin, systemRole: SystemRole): InputItem | undefined => {
  switch (item.type) {
    case 'reasoning': {
      const own = ownReasoning(item, origin);
      if (own === undefined || own.encrypted_content === undefined || own.encrypted_content === null) return undefined;
      return {
        type: 'reasoning',
        summary: own.summary,
        ...(own.content === undefined || own.content === null ? {} : { content: own.content }),
        encrypted_content: own.encrypted_content,
      };
    }
    case 'compaction_summary':
      return compactionSummaryMessage(item.summary, 'model');
    case 'message':
      return { type: 'message', role: item.role === 'system' ? systemRole : item.role, content: relayable(item.content, item.role === 'user' ? USER_PART_TYPES : TEXT_PART_TYPES) };
    case 'function_call':
      return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: callArgumentsText(item.arguments) };
    case 'function_call_output':
      return { type: 'function_call_output', call_id: item.call_id, output: relayable(item.output, USER_PART_TYPES) };
  }
};

export type ResponsesRendering = {
  schemaDialect?: DialectId;
  userDialects?: UserDialects;
  ledger?: RenderLedger;
  jsonReply?: JsonReplyPlan | undefined;
  carriesOutputBound?: boolean;
  output?: OutputTokenCapabilities;
  systemRole?: SystemRole;
  toolPlacement?: ToolPlacement;
};

export const carriesResponsesOutputBound = (capabilities: Pick<Capabilities, 'outputBoundField'>): boolean => capabilities.outputBoundField !== 'none';

const textFieldOf = (plan: JsonReplyPlan | undefined, dialect: ResolvedDialect): { text?: { format: unknown } } => {
  if (isJsonOnlyEnforced(plan)) return { text: { format: { type: 'json_object' } } };
  const format = jsonReplyFormatOf(plan, dialect);
  return format === undefined ? {} : { text: { format: { type: 'json_schema', ...format } } };
};

const isWireEffort = (effort: ReasoningEffort): effort is OpenResponsesReasoningEffort => OPEN_RESPONSES_REASONING_EFFORTS.some((accepted) => accepted === effort);

const reasoningFieldOf = (request: AdapterRequest, output: OutputTokenCapabilities | undefined): Pick<OpenResponsesRequestBody, 'reasoning'> => {
  const requested = request.reasoning_effort;
  const reasoning = output?.reasoning;
  if (requested === undefined || reasoning === undefined || reasoning.control === 'none') return {};
  if (reasoning.control === 'thinking') {
    throw new UnsupportedInputError(
      'unsupported_input',
      'the target declares capabilities.reasoning with control "thinking", but the Open Responses wire carries reasoning only as an effort; declare control "reasoning_effort" or "none"',
      'reasoning_effort',
    );
  }
  const effort = clampReasoningEffort(requested, acceptedReasoningEfforts(reasoning).filter(isWireEffort));
  if (!isWireEffort(effort)) throw new Error(`the reasoning effort ${effort} is not one the Open Responses wire accepts`);
  return { reasoning: { effort } };
};

const outputBoundFieldOf = (request: AdapterRequest, rendering: ResponsesRendering): Pick<OpenResponsesRequestBody, 'max_output_tokens'> => {
  const requested = request.max_output_tokens;
  if (rendering.carriesOutputBound === false || requested === undefined || requested === null) return {};
  return { max_output_tokens: rendering.output === undefined ? requested : outputTokensFor(rendering.output, request.reasoning_effort, requested) };
};

export const buildResponsesBody = (request: AdapterRequest, origin: ReasoningOrigin, rendering: ResponsesRendering = {}): OpenResponsesRequestBody => {
  const dialect = resolveDialect(rendering.schemaDialect ?? DEFAULT_DIALECT_ID, rendering.userDialects ?? NO_USER_DIALECTS);
  const tools = (request.tools ?? []).map((tool): FunctionTool => {
    const { parameters: _parameters, ...rest } = tool;
    const { schema } = renderToolParameters(tool, dialect, rendering.ledger);
    return schema === undefined ? rest : { ...rest, parameters: schema as NonNullable<FunctionTool['parameters']> };
  });
  const systemRole = rendering.systemRole ?? DEFAULT_SYSTEM_ROLE;
  const input = request.input.flatMap((item) => itemOf(item, origin, systemRole) ?? []);
  const additional = tools.length > 0 && (rendering.toolPlacement ?? DEFAULT_TOOL_PLACEMENT) === 'additional_tools';
  return {
    ...request.unknownFields,
    model: request.model,
    input: additional ? [{ type: 'additional_tools', role: 'developer', tools }, ...input] : input,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(request.instructions === undefined || request.instructions === null || request.instructions === '' ? {} : { instructions: request.instructions }),
    ...(tools.length === 0 || additional ? {} : { tools }),
    ...(tools.length === 0 || request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
    ...(tools.length === 0 || request.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: request.parallel_tool_calls }),
    ...outputBoundFieldOf(request, rendering),
    ...reasoningFieldOf(request, rendering.output),
    ...textFieldOf(rendering.jsonReply, dialect),
    ...carriedSamplingOf(request),
  };
};
