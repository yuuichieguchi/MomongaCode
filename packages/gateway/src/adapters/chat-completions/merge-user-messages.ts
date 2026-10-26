import type { ChatMessage } from './plain-history.ts';

export const USER_PART_SEPARATOR = '\n\n';

const isStringUserMessage = (message: ChatMessage): message is ChatMessage & { content: string } =>
  message['role'] === 'user' && typeof message['content'] === 'string';

export const mergeAdjacentUserMessages = (messages: readonly ChatMessage[]): ChatMessage[] => {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous !== undefined && isStringUserMessage(previous) && isStringUserMessage(message)) {
      merged[merged.length - 1] = { ...previous, content: `${previous.content}${USER_PART_SEPARATOR}${message.content}` };
    } else {
      merged.push({ ...message });
    }
  }
  return merged;
};
