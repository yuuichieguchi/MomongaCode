import { isRecord } from '@momonga/foundation';
import { PROMPT_PART_KEYS, type PromptPartKey } from './prompt-parts.ts';

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

const renderPart: Record<PromptPartKey, (value: unknown) => string[]> = {
  messages: textOfEntries,
  system: textOfContent,
  instructions: textOfContent,
  input: textOfEntries,
  tools: (value) => (value === undefined ? [] : [JSON.stringify(value)]),
};

export const textOfWire = (renderedWire: Record<string, unknown>): string =>
  PROMPT_PART_KEYS.flatMap((key) => renderPart[key](renderedWire[key]))
    .filter((part) => part !== '')
    .join('\n');
