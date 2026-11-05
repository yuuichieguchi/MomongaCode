import { isRecord } from '@momonga/foundation';
import { promptPartsOf } from './prompt-parts.ts';
export const textOfWire = (renderedWire: Record<string, unknown>): string => {
  const wire = promptPartsOf(renderedWire);
  const parts: string[] = [];
  const messages = wire['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const content = message['content'];
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) {
        for (const part of content) if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') parts.push(part['text']);
      }
      if (message['tool_calls'] !== undefined) parts.push(JSON.stringify(message['tool_calls']));
    }
  }
  const system = wire['system'];
  if (typeof system === 'string') parts.push(system);
  else if (Array.isArray(system)) {
    for (const block of system) if (isRecord(block) && typeof block['text'] === 'string') parts.push(block['text']);
  }
  if (wire['tools'] !== undefined) parts.push(JSON.stringify(wire['tools']));
  return parts.filter((part) => part !== '').join('\n');
};
