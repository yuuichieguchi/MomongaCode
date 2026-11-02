export const MIN_INDEXED_TERM_CHARS = 3;

export const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export const termsOf = (query: string): string[] => query.split(/\s+/).filter((term) => term !== '').map(asciiLower);

export const quoted = (term: string): string => `"${term.replaceAll('"', '""')}"`;

export type PartitionedTerms = { indexed: string[]; short: string[] };

const MIN_NON_ASCII_TERM_CHARS = 2;

const lengthOf = (term: string): number => [...term].length;

const carriesAQuery = (term: string): boolean =>
  lengthOf(term) >= MIN_INDEXED_TERM_CHARS || (lengthOf(term) >= MIN_NON_ASCII_TERM_CHARS && /[^\u0000-\u007f]/u.test(term));

export const partitionTerms = (terms: readonly string[]): PartitionedTerms => {
  const kept = terms.some(carriesAQuery) ? terms.filter(carriesAQuery) : terms;
  return {
    indexed: kept.filter((term) => lengthOf(term) >= MIN_INDEXED_TERM_CHARS),
    short: kept.filter((term) => lengthOf(term) < MIN_INDEXED_TERM_CHARS),
  };
};

export const instrFilters = (column: string, shortTerms: readonly string[]): { sql: string; params: Record<string, string> } => ({
  sql: shortTerms.map((_term, index) => ` AND instr(lower(${column}), :short${index}) > 0`).join(''),
  params: Object.fromEntries(shortTerms.map((term, index) => [`short${index}`, term])),
});
