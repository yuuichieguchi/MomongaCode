export { MIN_INDEXED_TERM_CHARS, asciiLower, partitionTerms, termsOf } from '@momonga/protocol';
export type { PartitionedTerms } from '@momonga/protocol';

export const quoted = (term: string): string => `"${term.replaceAll('"', '""')}"`;

export const instrFilters = (column: string, shortTerms: readonly string[]): { sql: string; params: Record<string, string> } => ({
  sql: shortTerms.map((_term, index) => ` AND instr(lower(${column}), :short${index}) > 0`).join(''),
  params: Object.fromEntries(shortTerms.map((term, index) => [`short${index}`, term])),
});
