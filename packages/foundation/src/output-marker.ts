export const OUTPUT_READER_TOOL = 'ReadOutput';

export const TRUNCATION_MARKER_SOURCE = `\\[… (\\d+) tokens omitted; full output stored as (\\S+); read it with ${OUTPUT_READER_TOOL} …\\]`;

export const truncationMarker = (tokens: number, handle: string): string =>
  `[… ${tokens} tokens omitted; full output stored as ${handle}; read it with ${OUTPUT_READER_TOOL} …]`;
