export const sameRunRequest = (found: { requestDigest: string | null }, requestDigest: string | undefined): boolean =>
  found.requestDigest !== null && found.requestDigest === requestDigest;
