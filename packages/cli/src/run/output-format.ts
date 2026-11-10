export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
