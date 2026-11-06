export const MAX_TOOL_NAME_CHARS = 64;

export const REFERENCE_KINDS = ['output_handle', 'history_range'] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
