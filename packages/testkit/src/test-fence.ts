export const TEST_FENCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

export const fenceBoundaryIn = (fenced: string): string => {
  const match = / boundary="([0-9a-f]+)">\n/.exec(fenced);
  if (match?.[1] === undefined) throw new Error(`no fence boundary in ${JSON.stringify(fenced.slice(0, 200))}`);
  return match[1];
};
