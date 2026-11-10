import { spanValueOfJsonText } from '@momonga/foundation';
import type { ChatRequestContent, GenAiMessage, GenAiPart, GenAiToolDefinition } from '@momonga/observability';
import type { AdapterInputItem, ContentPart, FunctionTool, ItemField } from '@momonga/protocol';

const NON_TEXT_PART = '[non-text content omitted]';

const textOfPart = (part: ContentPart): string => {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'summary_text':
    case 'reasoning_text':
      return part.text;
    case 'refusal':
      return part.refusal;
    case 'input_image':
    case 'input_file':
      return NON_TEXT_PART;
  }
};

const textParts = (content: string | readonly ContentPart[]): GenAiPart[] =>
  typeof content === 'string' ? [{ type: 'text', content }] : content.map((part): GenAiPart => ({ type: 'text', content: textOfPart(part) }));

const responseOf = (output: string | readonly ContentPart[]): unknown => (typeof output === 'string' ? spanValueOfJsonText(output) : output.map(textOfPart).join('\n'));

const inputMessageOf = (item: AdapterInputItem): GenAiMessage[] => {
  switch (item.type) {
    case 'message':
      return [{ role: item.role, parts: textParts(item.content) }];
    case 'function_call':
      return [{ role: 'assistant', parts: [{ type: 'tool_call', id: item.call_id, name: item.name, arguments: spanValueOfJsonText(item.arguments) }] }];
    case 'function_call_output':
      return [{ role: 'tool', parts: [{ type: 'tool_call_response', id: item.call_id, response: responseOf(item.output) }] }];
    case 'compaction_summary':
      return [{ role: 'user', parts: [{ type: 'text', content: item.summary }] }];
    case 'reasoning':
      return [];
  }
};

const definitionOf = (tool: FunctionTool): GenAiToolDefinition => ({
  type: 'function',
  name: tool.name,
  ...(tool.description === undefined || tool.description === null ? {} : { description: tool.description }),
  ...(tool.parameters === undefined || tool.parameters === null ? {} : { parameters: tool.parameters }),
});

export const chatRequestContentOf = (
  input: readonly AdapterInputItem[],
  instructions: string | null | undefined,
  tools: readonly FunctionTool[] | null | undefined,
): ChatRequestContent => ({
  ...(instructions === undefined || instructions === null ? {} : { systemInstructions: [{ type: 'text', content: instructions }] }),
  inputMessages: input.flatMap(inputMessageOf),
  ...(tools === undefined || tools === null || tools.length === 0 ? {} : { toolDefinitions: tools.map(definitionOf) }),
});

export const chatResponseMessagesOf = (output: readonly ItemField[], finishReason: string): GenAiMessage[] => {
  const parts = output.flatMap((item): GenAiPart[] => {
    switch (item.type) {
      case 'message':
        return item.content.map((part): GenAiPart => ({ type: 'text', content: textOfPart(part) }));
      case 'function_call':
        return [{ type: 'tool_call', id: item.call_id, name: item.name, arguments: spanValueOfJsonText(item.arguments) }];
      case 'function_call_output':
      case 'reasoning':
      case 'compaction':
        return [];
    }
  });
  return [{ role: 'assistant', parts, finish_reason: finishReason }];
};
