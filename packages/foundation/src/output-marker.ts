export const OUTPUT_READER_TOOL = 'ReadOutput';

export const TRUNCATION_MARKER_SOURCE = '\\[… (\\d+) tokens omitted; full output stored as (\\S+?)(?:; read it with \\S+)? …\\]';

export const truncationMarker = (tokens: number, handle: string, reader: string | undefined): string =>
  `[… ${tokens} tokens omitted; full output stored as ${handle}${reader === undefined ? '' : `; read it with ${reader}`} …]`;
