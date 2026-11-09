export const UNKNOWN_VALUE = 'unknown' as const;

export type Stored<T extends string> = T | typeof UNKNOWN_VALUE;
