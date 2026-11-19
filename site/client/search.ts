export type SearchRecord = { url: string; title: string; text: string };

const termsOf = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');

export const searchRecords = (records: readonly SearchRecord[], query: string): SearchRecord[] => {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  return records
    .map((record, index) => {
      const title = record.title.toLowerCase();
      const whole = `${title} ${record.text.toLowerCase()}`;
      return { record, index, matches: terms.every((term) => whole.includes(term)), inTitle: terms.filter((term) => title.includes(term)).length };
    })
    .filter((scored) => scored.matches)
    .sort((first, second) => second.inTitle - first.inTitle || first.index - second.index)
    .map((scored) => scored.record);
};
