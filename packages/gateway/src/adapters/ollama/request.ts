import { DEFAULT_DIALECT_ID, acceptedReasoningEfforts, clampReasoningEffort } from '@momonga/protocol';
import type { ToolChoiceWire, AdapterRequest, Capabilities, FunctionTool, ReasoningCapability, ReasoningEffort, ReasoningOrigin } from '@momonga/protocol';
import { NO_USER_DIALECTS, resolveDialect } from '../../dialect/choice.ts';
import type { UserDialects } from '../../dialect/choice.ts';
import { RenderLedger } from '../../dialect/ledger.ts';
import type { ResolvedDialect } from '../../dialect/render.ts';
import { renderToolParameters } from '../../dialect/tool-render.ts';
import { forbidsTools } from '../../core/tool-choice.ts';
import { isJsonOnlyEnforced, jsonReplyFormatOf } from '../shared/json-reply.ts';
import type { JsonReplyPlan } from '../shared/json-reply.ts';
import { carriedSamplingOf } from '../shared/sampling.ts';
import { SYSTEM_PART_SEPARATOR, systemTextOf } from '../shared/system-text.ts';
import { ollamaHistoryOf } from './history.ts';
import type { OllamaMessage } from './history.ts';

export type OllamaChatBody = {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  truncate: false;
  options: { num_ctx?: number; num_predict: number; temperature?: number; top_p?: number; frequency_penalty?: number; presence_penalty?: number };
  tools?: unknown[];
  format?: unknown;
  think?: boolean;
};

const toolOf = (tool: FunctionTool, dialect: ResolvedDialect, ledger: RenderLedger): unknown => {
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

const sendsTools = (request: AdapterRequest): boolean => (request.tools ?? []).length > 0 && !forbidsTools(request.tool_choice);

const requireToolChoice = (request: AdapterRequest): void => {
  const choice = request.tool_choice;
  if (choice === undefined || choice === 'auto' || choice === 'none') return;
  throw new Error('the tool_choice must be resolved against the Ollama wire before the body is built');
};

export const OLLAMA_TOOL_CHOICE: ToolChoiceWire = { forms: ['filter'], expressesRequired: false };

const formatOf = (plan: JsonReplyPlan | undefined, dialect: ResolvedDialect): { format?: unknown } => {
  if (isJsonOnlyEnforced(plan)) return { format: 'json' };
  const format = jsonReplyFormatOf(plan, dialect);
  return format === undefined ? {} : { format: format.schema };
};

const thinkOf = (effort: ReasoningEffort | undefined, reasoning: ReasoningCapability | undefined): { think?: boolean } =>
  effort === undefined || reasoning?.control !== 'reasoning_effort' ? {} : { think: clampReasoningEffort(effort, acceptedReasoningEfforts(reasoning)) !== 'none' };

export type OllamaBodyCapabilities = Pick<Capabilities, 'maxOutputTokens' | 'reasoning'>;

export type OllamaRendering = { userDialects?: UserDialects; ledger?: RenderLedger; jsonReply?: JsonReplyPlan | undefined };

export const buildOllamaChatBody = (
  request: AdapterRequest,
  capabilities: OllamaBodyCapabilities & { schemaDialect?: Capabilities['schemaDialect'] },
  statedWindow: number | undefined,
  stream: boolean,
  origin: ReasoningOrigin,
  rendering: OllamaRendering = {},
): OllamaChatBody => {
  requireToolChoice(request);
  const dialect = resolveDialect(capabilities.schemaDialect ?? DEFAULT_DIALECT_ID, rendering.userDialects ?? NO_USER_DIALECTS);
  const ledger = rendering.ledger ?? new RenderLedger();
  const system = systemTextOf(request.instructions, request.input);
  const messages = [...(system.length === 0 ? [] : [{ role: 'system', content: system.join(SYSTEM_PART_SEPARATOR) }]), ...ollamaHistoryOf(request.input, origin, request.fence)];
  return {
    model: request.model,
    messages,
    stream,
    truncate: false,
    options: {
      ...(statedWindow === undefined ? {} : { num_ctx: statedWindow }),
      num_predict: request.max_output_tokens ?? capabilities.maxOutputTokens,
      ...carriedSamplingOf(request),
    },
    ...(sendsTools(request) ? { tools: (request.tools ?? []).map((tool) => toolOf(tool, dialect, ledger)) } : {}),
    ...formatOf(rendering.jsonReply, dialect),
    ...thinkOf(request.reasoning_effort, capabilities.reasoning),
  };
};

export const buildOllamaBody = (
  request: AdapterRequest,
  capabilities: OllamaBodyCapabilities & { schemaDialect?: Capabilities['schemaDialect'] },
  statedWindow: number | undefined,
  origin: ReasoningOrigin,
  rendering?: OllamaRendering,
): OllamaChatBody => buildOllamaChatBody(request, capabilities, statedWindow, true, origin, rendering);
