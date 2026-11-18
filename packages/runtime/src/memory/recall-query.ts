import path from 'node:path';
import { safeSlice } from '@momonga/foundation';
import { MEMORY_QUERY_MAX_CHARS } from '@momonga/tools';

export type RecallQuery = { query: string; touchedCap: number | undefined };

const insideOf = (project: string, touched: string): string | undefined => {
  const relative = path.relative(project, touched);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative;
};

export const recallQueryOf = (task: string, newestFirst: readonly string[], project: string, rowsAsked: number): RecallQuery => {
  const used: string[] = [];
  let length = 0;
  let leftOut = false;
  for (const touched of newestFirst) {
    const relative = insideOf(project, touched);
    if (relative === undefined) continue;
    const grown = length + (used.length === 0 ? 0 : 1) + relative.length;
    if (grown > MEMORY_QUERY_MAX_CHARS) {
      leftOut = true;
      break;
    }
    used.push(relative);
    length = grown;
  }
  const query = [safeSlice(task, 0, MEMORY_QUERY_MAX_CHARS), used.join(' ')].join(' ');
  return { query, touchedCap: leftOut || newestFirst.length >= rowsAsked ? used.length : undefined };
};

export const termsOfQuery = (query: string): string[] => [...new Set(query.split(/\s+/).filter((term) => term !== ''))];
