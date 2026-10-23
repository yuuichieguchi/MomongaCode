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

export const TARGET_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9._-]*$';
export const ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';

const POSITIVE_INTEGER = { type: 'integer', minimum: 1 } as const;
const NON_NEGATIVE_INTEGER = { type: 'integer', minimum: 0 } as const;

const FM_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'fm' },
    model: { type: 'string', minLength: 1 },
    toolCalling: { enum: ['auto', 'native', 'constrained'] },
    maxConcurrency: POSITIVE_INTEGER,
    admissionTimeoutMs: NON_NEGATIVE_INTEGER,
  },
  required: ['adapter'],
  additionalProperties: false,
} as const;

const TARGET_CAPABILITIES_SCHEMA = {
  type: 'object',
  properties: {
    contextWindow: POSITIVE_INTEGER,
    maxOutputTokens: POSITIVE_INTEGER,
    structuredOutput: { enum: ['json_schema', 'none'] },
    streaming: { type: 'boolean' },
    stopSequences: { type: 'boolean' },
    imageInput: { type: 'boolean' },
    parallelToolCalls: { type: 'boolean' },
    schemaDialect: { enum: ['json-schema-2020-12', 'fm-generation'] },
    tokenCounting: { enum: ['exact', 'calibrated', 'estimated'] },
    usageReported: { type: 'boolean' },
    source: { enum: ['declared', 'probed', 'config', 'unprobed'] },
  },
  required: ['contextWindow', 'maxOutputTokens'],
  additionalProperties: false,
} as const;

const CHAT_COMPLETIONS_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'chat-completions' },
    model: { type: 'string', minLength: 1 },
    baseUrl: { type: 'string', minLength: 1 },
    socketPath: { type: 'string', minLength: 1 },
    apiKeyEnv: { type: 'string', pattern: ENV_NAME_PATTERN },
    toolCalling: { enum: ['native', 'constrained'] },
    capabilities: TARGET_CAPABILITIES_SCHEMA,
    maxConcurrency: POSITIVE_INTEGER,
    admissionTimeoutMs: NON_NEGATIVE_INTEGER,
  },
  required: ['adapter', 'model', 'capabilities'],
  additionalProperties: false,
} as const;

const MODEL_TARGET_SCHEMA = {
  type: 'object',
  discriminator: { propertyName: 'adapter' },
  oneOf: [FM_TARGET_SCHEMA, CHAT_COMPLETIONS_TARGET_SCHEMA],
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
        aliases: {
          type: 'object',
          additionalProperties: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }] },
        },
        targets: {
          type: 'object',
          propertyNames: { pattern: TARGET_NAME_PATTERN },
          additionalProperties: MODEL_TARGET_SCHEMA,
        },
      },
      additionalProperties: false,
    },
    autoUpdates: { type: 'boolean' },
    sandbox: { enum: ['seatbelt', 'none'] },
  },
} as const;

export const MCP_SERVERS_FILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    mcpServers: { type: 'object' },
  },
} as const;
