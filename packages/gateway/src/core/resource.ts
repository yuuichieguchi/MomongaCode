import type {
  CreateResponseBody,
  FunctionTool,
  ReasoningConfig,
  ResponseFunctionTool,
  ResponseReasoning,
  ResponseResource,
  ResponseTextField,
  ResponseTextFormat,
  TextField,
  TextFormat,
} from '@momonga/protocol';
import { echoedToolChoice } from './tool-choice.ts';

export type ResourceIdentity = { id: string; model: string; createdAtSeconds: number };

export type EchoedRequest = {
  tools?: CreateResponseBody['tools'] | undefined;
  text?: CreateResponseBody['text'] | undefined;
  reasoning?: CreateResponseBody['reasoning'] | undefined;
};

export type EchoedFields = Pick<ResponseResource, 'tools' | 'text' | 'reasoning'>;

const echoedTool = (tool: FunctionTool): ResponseFunctionTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description ?? null,
  parameters: tool.parameters ?? null,
  strict: tool.strict ?? false,
});

const echoedFormat = (format: TextFormat | null | undefined): ResponseTextFormat => {
  if (format === undefined || format === null) return { type: 'text' };
  if (format.type !== 'json_schema') return format;
  return { type: 'json_schema', name: format.name, description: format.description ?? null, schema: null, strict: format.strict ?? false };
};

const echoedText = (text: TextField | null | undefined): ResponseTextField => ({
  ...text,
  format: echoedFormat(text?.format),
});

const echoedReasoning = (reasoning: ReasoningConfig | null | undefined): ResponseReasoning | null =>
  reasoning === undefined || reasoning === null ? null : { effort: reasoning.effort ?? null, summary: reasoning.summary ?? null };

export const echoedFields = (request: EchoedRequest): EchoedFields => ({
  tools: (request.tools ?? []).map(echoedTool),
  text: echoedText(request.text),
  reasoning: echoedReasoning(request.reasoning),
});

export const baseResource = (
  body: CreateResponseBody,
  identity: ResourceIdentity,
): ResponseResource => ({
  id: identity.id,
  object: "response",
  created_at: identity.createdAtSeconds,
  completed_at: null,
  status: "in_progress",
  incomplete_details: null,
  model: identity.model,
  previous_response_id: body.previous_response_id ?? null,
  instructions: body.instructions ?? null,
  output: [],
  error: null,
  ...echoedFields(body),
  tool_choice: echoedToolChoice(body.tool_choice),
  truncation: body.truncation ?? "disabled",
  parallel_tool_calls: body.parallel_tool_calls ?? false,
  top_p: body.top_p ?? 1,
  presence_penalty: body.presence_penalty ?? 0,
  frequency_penalty: body.frequency_penalty ?? 0,
  top_logprobs: body.top_logprobs ?? 0,
  temperature: body.temperature ?? 1,
  usage: null,
  max_output_tokens: body.max_output_tokens ?? null,
  max_tool_calls: body.max_tool_calls ?? null,
  store: body.store ?? false,
  background: false,
  service_tier: body.service_tier ?? "default",
  metadata: body.metadata ?? {},
  safety_identifier: body.safety_identifier ?? null,
  prompt_cache_key: body.prompt_cache_key ?? null,
});
