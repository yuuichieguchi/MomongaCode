export const OUTPUT_STYLES = ['standard', 'concise', 'explanatory'] as const;

export type OutputStyle = (typeof OUTPUT_STYLES)[number];

export const DEFAULT_OUTPUT_STYLE: OutputStyle = 'standard';

export const isOutputStyle = (value: unknown): value is OutputStyle =>
  typeof value === 'string' && (OUTPUT_STYLES as readonly string[]).includes(value);
