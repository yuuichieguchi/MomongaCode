export const FILE_CANDIDATE_LIMIT = 50_000;

export type FileCandidates = { entries: string[]; truncated: boolean };

export const directoryEntriesOf = (files: readonly string[]): string[] => {
  const names = new Set<string>();
  for (const file of files) {
    const slash = file.indexOf('/');
    names.add(slash < 0 ? file : file.slice(0, slash + 1));
  }
  return [...names].sort();
};
