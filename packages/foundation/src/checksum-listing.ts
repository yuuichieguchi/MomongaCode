export const parseChecksumListing = (listing: string, label: string): ReadonlyMap<string, string> => {
  const entries = listing
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      if (!match) throw new Error(`malformed ${label} line: ${line}`);
      return [match[2] as string, match[1] as string] as const;
    });
  return new Map(entries);
};
