import path from 'node:path';
import { safeSlice } from '@momonga/foundation';
import { MEMORY_QUERY_MAX_CHARS } from '@momonga/tools';

export const recallQueryOf = (task: string, touchedPaths: readonly string[], project: string): string => {
  const inside = touchedPaths.map((touched) => path.relative(project, touched)).filter((relative) => relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
  return [safeSlice(task, 0, MEMORY_QUERY_MAX_CHARS), safeSlice([...new Set(inside)].join(' '), 0, MEMORY_QUERY_MAX_CHARS)].join(' ');
};

export const termsOfQuery = (query: string): string[] => [...new Set(query.split(/\s+/).filter((term) => term !== ''))];
