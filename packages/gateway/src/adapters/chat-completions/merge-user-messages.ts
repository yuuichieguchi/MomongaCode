import type { ChatMessage } from './plain-history.ts';

export const USER_PART_SEPARATOR = '\n\n';

type Content = string | Array<Record<string, unknown>>;

const isUserMessage = (message: ChatMessage): message is ChatMessage & { content: Content } =>
  message['role'] === 'user' && (typeof message['content'] === 'string' || Array.isArray(message['content']));

const partsOf = (content: Content): Array<Record<string, unknown>> => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

const joined = (previous: Content, next: Content): Content =>
  typeof previous === 'string' && typeof next === 'string' ? `${previous}${USER_PART_SEPARATOR}${next}` : [...partsOf(previous), ...partsOf(next)];

export const mergeAdjacentUserMessages = (messages: readonly ChatMessage[]): ChatMessage[] => {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous !== undefined && isUserMessage(previous) && isUserMessage(message)) {
      merged[merged.length - 1] = { ...previous, content: joined(previous.content, message.content) };
    } else {
      merged.push({ ...message });
    }
  }
  return merged;
};
