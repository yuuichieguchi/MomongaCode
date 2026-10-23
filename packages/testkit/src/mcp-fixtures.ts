import path from 'node:path';

export const MCP_MODERN_SERVER_PATH = path.join(import.meta.dirname, 'mcp-modern-server.ts');
export const MCP_LEGACY_SERVER_PATH = path.join(import.meta.dirname, 'mcp-legacy-server.ts');
export const MCP_RAW_STDIO_SERVER_PATH = path.join(import.meta.dirname, 'mcp-raw-stdio-server.ts');
export const MODERN_FIXTURE_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_FIXTURE_PROTOCOL_VERSION = '2025-11-25';
export const MODERN_FIXTURE_RECORD_ENV = 'MCP_FIXTURE_RECORD_FILE';
export const MODERN_FIXTURE_GRANDCHILD_ENV = 'MCP_FIXTURE_SPAWN_GRANDCHILD';
export const MODERN_FIXTURE_PAGE_SIZE = 6;
export const MODERN_FIXTURE_LONG_TOOL_NAME = `long_${'x'.repeat(90)}`;
export const MODERN_FIXTURE_IMAGE_BYTES = 'fixture-png-bytes';
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
] as const;
export const LEGACY_FIXTURE_TOOL_NAMES = ['echo', 'add'] as const;

export type ModernFixtureRecord =
  | { type: 'ready'; pid: number }
  | { type: 'grandchild'; pid: number }
  | { type: 'list'; cursor: string | null }
  | { type: 'call'; tool: string; meta: Record<string, unknown> | null; envelope: Record<string, unknown> | null }
  | { type: 'cancelled'; tool: string; requestId: number | string; reason: string };
