export const MIN_INDEXED_TERM_CHARS = 3;

export const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export const termsOf = (query: string): string[] => query.split(/\s+/).filter((term) => term !== '').map(asciiLower);

export const quoted = (term: string): string => `"${term.replaceAll('"', '""')}"`;

export type PartitionedTerms = { indexed: string[]; short: string[] };

export const partitionTerms = (terms: readonly string[]): PartitionedTerms => ({
  indexed: terms.filter((term) => [...term].length >= MIN_INDEXED_TERM_CHARS),
  short: terms.filter((term) => [...term].length < MIN_INDEXED_TERM_CHARS),
});

export const instrFilters = (column: string, shortTerms: readonly string[]): { sql: string; params: Record<string, string> } => ({
  sql: shortTerms.map((_term, index) => ` AND instr(lower(${column}), :short${index}) > 0`).join(''),
  params: Object.fromEntries(shortTerms.map((term, index) => [`short${index}`, term])),
});
