import type { AdapterInputItem } from '@momonga/protocol';
import { textOfContent } from './input-text.ts';

export const SYSTEM_PART_SEPARATOR = '\n\n';

export const systemTextOf = (instructions: string | null | undefined, input: readonly AdapterInputItem[]): string[] => {
  const parts: string[] = [];
  if (instructions !== undefined && instructions !== null && instructions !== '') parts.push(instructions);
  for (const item of input) {
    if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
      parts.push(textOfContent(item.content));
    }
  }
  return parts.filter((part) => part !== '');
};
