import type { MessageItem, ResponseResource, StreamEvent, Usage } from '@momonga/protocol';

export const usageOf = (inputTokens: number, outputTokens: number): Usage => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  total_tokens: inputTokens + outputTokens,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
});

export type ResponseResourceInput = {
  id: string;
  model: string;
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete';
  output?: ResponseResource['output'];
  usage?: Usage | null;
  createdAt?: number;
  completedAt?: number | null;
};

export const responseResource = (input: ResponseResourceInput): ResponseResource => ({
  id: input.id,
  object: 'response',
  created_at: input.createdAt ?? 1_800_000_000,
  completed_at: input.completedAt ?? null,
  status: input.status,
  incomplete_details: null,
  model: input.model,
  previous_response_id: null,
  instructions: null,
  output: input.output ?? [],
  error: null,
  tools: [],
  tool_choice: 'auto',
  truncation: 'disabled',
  parallel_tool_calls: false,
  text: { format: { type: 'text' } },
  top_p: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
  top_logprobs: 0,
  temperature: 1,
  reasoning: null,
  usage: input.usage ?? null,
  max_output_tokens: null,
  max_tool_calls: null,
  store: false,
  background: false,
  service_tier: 'default',
  metadata: {},
  safety_identifier: null,
  prompt_cache_key: null,
});

export type TextResponseScript = {
  model: string;
  chunks: readonly string[];
  usage?: Usage | null;
  responseId?: string;
  itemId?: string;
};

export const textResponseEvents = (script: TextResponseScript): StreamEvent[] => {
  const responseId = script.responseId ?? 'upstream_resp_1';
  const itemId = script.itemId ?? 'msg_upstream_1';
  const text = script.chunks.join('');
  const doneItem: MessageItem = {
    type: 'message',
    id: itemId,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const events: StreamEvent[] = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: responseResource({ id: responseId, model: script.model, status: 'in_progress' }),
    },
    {
      type: 'response.in_progress',
      sequence_number: 1,
      response: responseResource({ id: responseId, model: script.model, status: 'in_progress' }),
    },
    {
      type: 'response.output_item.added',
      sequence_number: 2,
      output_index: 0,
      item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 3,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  ];
  for (const chunk of script.chunks) {
    events.push({
      type: 'response.output_text.delta',
      sequence_number: events.length,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: chunk,
    });
  }
  events.push(
    {
      type: 'response.output_text.done',
      sequence_number: events.length,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      sequence_number: events.length + 1,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    },
    { type: 'response.output_item.done', sequence_number: events.length + 2, output_index: 0, item: doneItem },
    {
      type: 'response.completed',
      sequence_number: events.length + 3,
      response: responseResource({
        id: responseId,
        model: script.model,
        status: 'completed',
        output: [doneItem],
        usage: script.usage === undefined ? usageOf(11, 3) : script.usage,
        completedAt: 1_800_000_001,
      }),
    },
  );
  return events;
};
