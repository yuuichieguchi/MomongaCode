import { PERMISSION_MODES } from '@momonga/protocol';

const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;
const STRING_MAP = { type: 'object', additionalProperties: { type: 'string' } } as const;

export const MCP_SERVER_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'stdio' },
        command: { type: 'string', minLength: 1 },
        args: STRING_ARRAY,
        env: STRING_MAP,
        cwd: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['http', 'sse'] },
        url: { type: 'string', minLength: 1 },
        headers: STRING_MAP,
      },
      required: ['type', 'url'],
      additionalProperties: false,
    },
  ],
} as const;

export const SETTINGS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    permissions: {
      type: 'object',
      properties: {
        defaultMode: { type: 'string', enum: [...PERMISSION_MODES] },
        allow: STRING_ARRAY,
        ask: STRING_ARRAY,
        deny: STRING_ARRAY,
        additionalDirectories: STRING_ARRAY,
      },
      additionalProperties: false,
    },
    env: STRING_MAP,
    enabledMcpjsonServers: STRING_ARRAY,
    disabledMcpjsonServers: STRING_ARRAY,
    enableAllProjectMcpServers: { type: 'boolean' },
    mcpServers: { type: 'object', additionalProperties: MCP_SERVER_SCHEMA },
    models: {
      type: 'object',
      properties: {
        aliases: STRING_MAP,
        targets: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: { adapter: { type: 'string' }, model: { type: 'string' } },
            required: ['adapter', 'model'],
          },
        },
      },
      additionalProperties: false,
    },
    autoUpdates: { type: 'boolean' },
  },
} as const;

export const MCP_SERVERS_FILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    mcpServers: { type: 'object', additionalProperties: MCP_SERVER_SCHEMA },
  },
} as const;
