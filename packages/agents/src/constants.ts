import path from 'node:path';

export { AGENT_TOOL_NAME } from '@momonga/protocol';

export const AGENT_DIRECTORY_SEGMENTS = path.join('.momonga', 'agents');

export const AGENT_FILE_SUFFIX = '.md';

export const AGENT_NAME_MAX_LENGTH = 256;

export const SPAWN_TOOL_TIMEOUT_MS = 10_000;

export const SUPPORTED_FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'tools', 'model', 'color', 'conditions', 'requirements', 'inherit']);

export const INHERIT_MODEL = 'inherit';
