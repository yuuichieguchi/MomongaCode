import { isRecord } from '@momonga/foundation';
import { promptPartsOf } from './prompt-parts.ts';

const textOfContent = (content: unknown): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []));
};

const textOfEntries = (entries: unknown): string[] => {
  if (typeof entries === 'string') return [entries];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const parts = textOfContent(entry['content']);
    if (entry['tool_calls'] !== undefined) parts.push(JSON.stringify(entry['tool_calls']));
    if (typeof entry['name'] === 'string' && typeof entry['arguments'] === 'string') parts.push(`${entry['name']} ${entry['arguments']}`);
    if (typeof entry['output'] === 'string') parts.push(entry['output']);
    return parts;
  });
};

export const textOfWire = (renderedWire: Record<string, unknown>): string => {
  const wire: Record<string, unknown> = promptPartsOf(renderedWire);
  const parts = [
    ...textOfEntries(wire['messages']),
    ...textOfContent(wire['system']),
    ...textOfContent(wire['instructions']),
    ...textOfEntries(wire['input']),
    ...(wire['tools'] === undefined ? [] : [JSON.stringify(wire['tools'])]),
  ];
  return parts.filter((part) => part !== '').join('\n');
};
