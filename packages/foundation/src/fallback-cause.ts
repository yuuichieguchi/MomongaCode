export type FallbackCause = { target: string; code: string | null; message: string };

export const describeFallbackCause = (cause: FallbackCause): string =>
  `${cause.target} failed (${cause.code === null ? cause.message : `${cause.code}: ${cause.message}`})`;
