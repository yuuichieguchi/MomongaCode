import { MAX_REDACTED_CHARS } from '@momonga/foundation';

export { MEMORY_SAVE_TOOL_NAME, MEMORY_SEARCH_TOOL_NAME } from '@momonga/protocol';

export const MEMORY_TEXT_MAX_CHARS = Math.floor(MAX_REDACTED_CHARS / 2);

export const MEMORY_QUERY_MAX_CHARS = 200;

export const MEMORY_SEARCH_RESULT_LIMIT = 10;

export const MEMORY_TOOL_TIMEOUT_MS = 5_000;
