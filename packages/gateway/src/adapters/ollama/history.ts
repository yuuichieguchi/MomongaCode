import { compactionSummaryMessage } from '@momonga/protocol';
import type { AdapterInputItem, ContentPart, ReasoningOrigin } from '@momonga/protocol';
import { callArgumentsObject, readableHistoryOf } from '../shared/call-arguments.ts';
import { UnsupportedInputError } from '../shared/failures.ts';
import { imageSourceOf, isImagePart } from '../shared/image-part.ts';
import { fenceOf, reasoningTextOf, textOfContent } from '../shared/input-text.ts';
import { ownReasoning } from '../shared/reasoning-origin.ts';

export type OllamaMessage = Record<string, unknown>;

type ToolCall = { function: { name: string; arguments: unknown } };
type AssistantDraft = { content: string; thinking: string | undefined; toolCalls: ToolCall[]; hasMessage: boolean };

const userMessageOf = (content: string | readonly ContentPart[]): OllamaMessage => {
  if (typeof content === 'string') return { role: 'user', content };
  const images = content.filter(isImagePart).map((part) => {
    const source = imageSourceOf(part);
    if (source.kind === 'url') {
      throw new UnsupportedInputError('unsupported_image_url', 'the Ollama adapter accepts images as base64 data: URLs only; the gateway does not fetch URLs', 'input');
    }
    return source.data;
  });
  const text = textOfContent(content.filter((part) => !isImagePart(part)));
  return { role: 'user', content: text, ...(images.length === 0 ? {} : { images }) };
};

export const ollamaHistoryOf = (input: readonly AdapterInputItem[], origin: ReasoningOrigin, fence?: string): OllamaMessage[] => {
  const messages: OllamaMessage[] = [];
  const namesByCallId = new Map<string, string>();
  let draft: AssistantDraft | undefined;
  let thinking: string | undefined;

  const flush = (): void => {
    if (draft === undefined) return;
    messages.push({
      role: 'assistant',
      content: draft.content,
      ...(draft.thinking === undefined ? {} : { thinking: draft.thinking }),
      ...(draft.toolCalls.length === 0 ? {} : { tool_calls: draft.toolCalls }),
    });
    draft = undefined;
  };
  const current = (): AssistantDraft => {
    draft ??= { content: '', thinking: undefined, toolCalls: [], hasMessage: false };
    return draft;
  };

  for (const item of readableHistoryOf(input, fence)) {
    if (item.type === 'reasoning') {
      const own = ownReasoning(item, origin);
      if (own === undefined) continue;
      const text = reasoningTextOf(own);
      if (text === '') continue;
      if (draft !== undefined && (draft.thinking !== undefined || draft.hasMessage || draft.toolCalls.length > 0)) flush();
      current().thinking = text;
      continue;
    }
    if (item.type === 'function_call') {
      namesByCallId.set(item.call_id, item.name);
      current().toolCalls.push({ function: { name: item.name, arguments: callArgumentsObject(item.arguments) } });
      continue;
    }
    if (item.type === 'message' && item.role === 'assistant') {
      if (draft !== undefined && (draft.hasMessage || draft.toolCalls.length > 0)) flush();
      const target = current();
      target.content = textOfContent(item.content);
      target.hasMessage = true;
      continue;
    }
    flush();
    if (item.type === 'compaction_summary') {
      const { role, content } = compactionSummaryMessage(item.summary, 'model', fenceOf(fence));
      messages.push({ role, content });
    } else if (item.type === 'function_call_output') {
      const name = namesByCallId.get(item.call_id);
      if (name === undefined) {
        throw new UnsupportedInputError('unknown_call_id', `function_call_output "${item.call_id}" has no matching function_call`, 'input');
      }
      messages.push({ role: 'tool', tool_name: name, content: textOfContent(item.output) });
    } else if (item.type === 'message' && item.role === 'user') {
      messages.push(userMessageOf(item.content));
    }
  }
  flush();
  return messages;
};
