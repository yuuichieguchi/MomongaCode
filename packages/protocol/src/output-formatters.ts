export const OUTPUT_FORMATTERS = ['log', 'json', 'grep', 'identicalOutput'] as const;

export type OutputFormatterName = (typeof OUTPUT_FORMATTERS)[number];
