import path from 'node:path';

export const MCP_MODERN_SERVER_PATH = path.join(import.meta.dirname, 'mcp-modern-server.ts');
export const MCP_LEGACY_SERVER_PATH = path.join(import.meta.dirname, 'mcp-legacy-server.ts');
export const MCP_RAW_STDIO_SERVER_PATH = path.join(import.meta.dirname, 'mcp-raw-stdio-server.ts');
export const MODERN_FIXTURE_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_FIXTURE_PROTOCOL_VERSION = '2025-11-25';
export const MODERN_FIXTURE_RECORD_ENV = 'MCP_FIXTURE_RECORD_FILE';
export const MODERN_FIXTURE_GRANDCHILD_ENV = 'MCP_FIXTURE_SPAWN_GRANDCHILD';
export const MODERN_FIXTURE_LIST_TTL_ENV = 'MCP_FIXTURE_LIST_TTL_MS';
export const MODERN_FIXTURE_STDERR_ENV = 'MCP_FIXTURE_STDERR_LINE';
export const MODERN_FIXTURE_PAGE_SIZE = 6;
export const MODERN_FIXTURE_LONG_TOOL_NAME = `long_${'x'.repeat(90)}`;
export const MODERN_FIXTURE_IMAGE_BYTES = 'fixture-png-bytes';
export const MODERN_FIXTURE_AUDIO_BYTES = 'fixture-audio';
export const MODERN_FIXTURE_BLOB_BYTES = 'blob-bytes';
export const MODERN_FIXTURE_HOSTILE_DESCRIPTION = `Line1\nTab\there\u0007bell\u001b[31mred\r${'d'.repeat(3000)}`;
export const MODERN_FIXTURE_OVERSIZED_DESCRIPTION_CHARS = 70_000;
export const MODERN_FIXTURE_TOOL_NAMES = [
  'echo',
  'add',
  'slow',
  'fail',
  'crash',
  'image',
  'structured',
  'trigger_list_changed',
  'read_only',
  'draft07',
  'dotted.name/with-slash',
  MODERN_FIXTURE_LONG_TOOL_NAME,
  'catastrophic_output',
  'content_kinds',
  'patterned',
  'oversized',
  'uncompilable',
  'dotted_name_with-slash',
] as const;
export const LEGACY_FIXTURE_TOOL_NAMES = ['echo', 'add', 'bare'] as const;

export type ModernFixtureRecord =
  | { type: 'ready'; pid: number }
  | { type: 'grandchild'; pid: number }
  | { type: 'list'; cursor: string | null }
  | { type: 'call'; tool: string; meta: Record<string, unknown> | null; envelope: Record<string, unknown> | null }
  | { type: 'cancelled'; tool: string; requestId: number | string; reason: string };

export const FIXTURE_EXTRA_TOOLS_ENV = 'MCP_FIXTURE_EXTRA_TOOLS';
export const FIXTURE_HOSTILE_TITLE = `Red\u001b[1;31mBold\u001b]0;set title\u0007\u0085C1\u202eBidi\u200bZero\ufeffBom\nNext\tTab${'T'.repeat(300)}`;
export const FIXTURE_HOSTILE_TITLE_DESCRIPTION = 'Desc\u0085C1\u2066iso\u2069\u2060wj\u200fend\u202aemb\nkeep\ttab \u001b]8;;https://evil.example\u0007link\u001b]8;;\u001b\\ tail\u001b(B!\u001b]0;unterminated title';
export const FIXTURE_ID_INPUT_SCHEMA_ID = 'https://fixture.example/with-id-input';
export const FIXTURE_ID_OUTPUT_SCHEMA_ID = 'https://fixture.example/with-id-output';

export const nestedNotSchema = (depth: number): Record<string, unknown> => {
  let inner: Record<string, unknown> = {};
  for (let level = 2; level < depth; level += 1) inner = { not: inner };
  return depth <= 1 ? { type: 'object' } : { type: 'object', not: inner };
};

export const withIdInputSchema = (): Record<string, unknown> => ({
  $id: FIXTURE_ID_INPUT_SCHEMA_ID,
  type: 'object',
  properties: { v: { type: 'string' } },
  required: ['v'],
});

export const withIdOutputSchema = (): Record<string, unknown> => ({
  $id: FIXTURE_ID_OUTPUT_SCHEMA_ID,
  type: 'object',
  properties: { v: { type: 'string' } },
  required: ['v'],
});

export const requestedExtraTools = (raw: string | undefined): string[] =>
  raw === undefined || raw === '' ? [] : raw.split(',').filter((name) => name !== '');
