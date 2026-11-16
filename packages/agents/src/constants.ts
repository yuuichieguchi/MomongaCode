import path from 'node:path';

import { AGENT_FOLDER_PARTS } from '@momonga/protocol';

export { AGENT_TOOL_NAME } from '@momonga/protocol';

export const AGENT_DIRECTORY_SEGMENTS = path.join(...AGENT_FOLDER_PARTS);

export { AGENT_FILE_SUFFIX } from '@momonga/protocol';

export const AGENT_NAME_MAX_LENGTH = 256;

export const SPAWN_TOOL_TIMEOUT_MS = 10_000;

export const SUPPORTED_FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'tools', 'model', 'color', 'conditions', 'requirements', 'inherit']);

export const INHERIT_MODEL = 'inherit';
