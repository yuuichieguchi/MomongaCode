import type { AdapterInputItem, AdapterRequest, FunctionTool, ReasoningOrigin, SamplingField, ToolChoice } from '@momonga/protocol';
import { allowedToolsModeOf } from '../../core/tool-choice.ts';
import { carriedSamplingOf } from '../shared/sampling.ts';
import { resolvedOf } from '../../dialect/choice.ts';
import type { DialectChoice } from '../../dialect/choice.ts';
import type { RenderLedger } from '../../dialect/ledger.ts';
import type { ResolvedDialect } from '../../dialect/render.ts';
import { renderToolParameters } from '../../dialect/tool-render.ts';
import { SYSTEM_PART_SEPARATOR, systemTextOf } from '../shared/system-text.ts';
import { nativeHistoryOf, plainHistoryOf } from './plain-history.ts';
import type { ChatMessage } from './plain-history.ts';

export type ChatRequestBody = {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  response_format?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  prompt_cache_key?: string;
};

const toolOf = (tool: FunctionTool, dialect: ResolvedDialect, ledger: RenderLedger | undefined): unknown => {
  const { schema: parameters } = renderToolParameters(tool, dialect, ledger);
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined || tool.description === null ? {} : { description: tool.description }),
      ...(parameters === undefined ? {} : { parameters }),
    },
  };
};

const toolChoiceOf = (choice: ToolChoice): unknown => {
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function') return { type: 'function', function: { name: choice.name } };
  return {
    type: 'allowed_tools',
    allowed_tools: { mode: allowedToolsModeOf(choice), tools: choice.tools.map((tool) => ({ type: 'function', function: { name: tool.name } })) },
  };
};

export const samplingOf = (request: AdapterRequest): Pick<ChatRequestBody, SamplingField> => carriedSamplingOf(request);

export const buildNativeBody = (request: AdapterRequest, origin: ReasoningOrigin, dialect: DialectChoice, ledger?: RenderLedger): ChatRequestBody => {
  const messages: ChatMessage[] = [];
  const tools = request.tools ?? [];
  const resolved = resolvedOf(dialect);
  const system = systemTextOf(request.instructions, request.input);
  if (system.length > 0) messages.push({ role: 'system', content: system.join(SYSTEM_PART_SEPARATOR) });
  messages.push(...(tools.length === 0 ? plainHistoryOf(request.input, { envelopeReplies: false, origin: origin }) : nativeHistoryOf(request.input, origin)));
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length === 0 ? {} : { tools: tools.map((tool) => toolOf(tool, resolved, ledger)) }),
    ...(tools.length === 0 || request.tool_choice === undefined ? {} : { tool_choice: toolChoiceOf(request.tool_choice) }),
    ...samplingOf(request),
  };
};
