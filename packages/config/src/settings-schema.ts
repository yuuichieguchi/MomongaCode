import { SECRET_NAME_PATTERN } from '@momonga/foundation';
import { HOOK_COMMAND_TYPE, PERMISSION_MODES, TARGET_BILLINGS } from '@momonga/protocol';

const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;
const NON_EMPTY_STRING_ARRAY = { type: 'array', items: { type: 'string', minLength: 1 } } as const;
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
        type: { type: 'string', const: 'http' },
        url: { type: 'string', minLength: 1 },
        headers: STRING_MAP,
        oauth: {
          type: 'object',
          properties: {
            clientId: { type: 'string', minLength: 1 },
            scope: { type: 'string', minLength: 1 },
            callbackPort: { type: 'integer', minimum: 1, maximum: 65535 },
          },
          additionalProperties: false,
        },
      },
      required: ['type', 'url'],
      additionalProperties: false,
    },
  ],
} as const;

export const TARGET_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9._-]*$';
export const ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';
export const PROVIDER_NAME_PATTERN = '^[a-z][a-z0-9._-]*$';

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
    imageTokens: {
      type: 'object',
      properties: { pixelsPerToken: { type: 'number', exclusiveMinimum: 0 }, maxTokens: POSITIVE_INTEGER },
      required: ['pixelsPerToken', 'maxTokens'],
      additionalProperties: false,
    },
    parallelToolCalls: { type: 'boolean' },
    schemaDialect: { enum: ['json-schema-2020-12', 'guided-generation'] },
    tokenCounting: { enum: ['exact', 'calibrated', 'estimated'] },
    tokenErrorRatio: { type: 'number', minimum: 0 },
    usageReported: { type: 'boolean' },
    source: { enum: ['declared', 'probed', 'config', 'unprobed'] },
  },
  required: ['contextWindow', 'maxOutputTokens'],
  additionalProperties: false,
} as const;

const BILLING_SCHEMA = { enum: [...TARGET_BILLINGS] } as const;

const API_KEY_PROPERTIES = {
  apiKeyEnv: { type: 'string', pattern: ENV_NAME_PATTERN },
  apiKeySecret: { type: 'string', pattern: SECRET_NAME_PATTERN },
} as const;

const AT_MOST_ONE_API_KEY = {
  not: { properties: { apiKeyEnv: true, apiKeySecret: true }, required: ['apiKeyEnv', 'apiKeySecret'] },
} as const;

const EXACTLY_ONE_API_KEY = {
  oneOf: [
    { properties: { apiKeyEnv: true }, required: ['apiKeyEnv'] },
    { properties: { apiKeySecret: true }, required: ['apiKeySecret'] },
  ],
} as const;

const CHAT_COMPLETIONS_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'chat-completions' },
    model: { type: 'string', minLength: 1 },
    baseUrl: { type: 'string', minLength: 1 },
    socketPath: { type: 'string', minLength: 1 },
    ...API_KEY_PROPERTIES,
    provider: { type: 'string', pattern: PROVIDER_NAME_PATTERN },
    toolCalling: { enum: ['native', 'constrained'] },
    billing: BILLING_SCHEMA,
    capabilities: TARGET_CAPABILITIES_SCHEMA,
    maxConcurrency: POSITIVE_INTEGER,
    admissionTimeoutMs: NON_NEGATIVE_INTEGER,
  },
  required: ['adapter', 'model', 'provider', 'capabilities'],
  ...AT_MOST_ONE_API_KEY,
  additionalProperties: false,
} as const;

const OPEN_RESPONSES_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'open-responses' },
    model: { type: 'string', minLength: 1 },
    baseUrl: { type: 'string', minLength: 1 },
    socketPath: { type: 'string', minLength: 1 },
    ...API_KEY_PROPERTIES,
    provider: { type: 'string', pattern: PROVIDER_NAME_PATTERN },
    toolCalling: { enum: ['native', 'none'] },
    billing: BILLING_SCHEMA,
    capabilities: TARGET_CAPABILITIES_SCHEMA,
    maxConcurrency: POSITIVE_INTEGER,
    admissionTimeoutMs: NON_NEGATIVE_INTEGER,
  },
  required: ['adapter', 'model', 'provider', 'capabilities'],
  ...AT_MOST_ONE_API_KEY,
  additionalProperties: false,
} as const;

const ANTHROPIC_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'anthropic' },
    model: { type: 'string', minLength: 1 },
    baseUrl: { type: 'string', minLength: 1 },
    socketPath: { type: 'string', minLength: 1 },
    ...API_KEY_PROPERTIES,
    billing: BILLING_SCHEMA,
    capabilities: TARGET_CAPABILITIES_SCHEMA,
    maxConcurrency: POSITIVE_INTEGER,
    admissionTimeoutMs: NON_NEGATIVE_INTEGER,
  },
  required: ['adapter', 'model', 'capabilities'],
  ...EXACTLY_ONE_API_KEY,
  additionalProperties: false,
} as const;

const MODEL_TARGET_SCHEMA = {
  type: 'object',
  discriminator: { propertyName: 'adapter' },
  oneOf: [FM_TARGET_SCHEMA, CHAT_COMPLETIONS_TARGET_SCHEMA, OPEN_RESPONSES_TARGET_SCHEMA, ANTHROPIC_TARGET_SCHEMA],
} as const;

const HOOK_COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    type: { const: HOOK_COMMAND_TYPE },
    command: { type: 'string', minLength: 1 },
    timeout: POSITIVE_INTEGER,
  },
  required: ['type', 'command'],
  additionalProperties: false,
} as const;

const HOOK_MATCHER_GROUP_SCHEMA = {
  type: 'object',
  properties: {
    matcher: { type: 'string' },
    hooks: { type: 'array', items: HOOK_COMMAND_SCHEMA, minItems: 1 },
  },
  required: ['hooks'],
  additionalProperties: false,
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
    hooks: { type: 'object', additionalProperties: { type: 'array', items: HOOK_MATCHER_GROUP_SCHEMA } },
    autoMode: {
      type: 'object',
      properties: { classifier: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
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
    memory: {
      type: 'object',
      properties: {
        reflection: {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, maxTokens: POSITIVE_INTEGER },
          additionalProperties: false,
        },
        forgetAfterDays: POSITIVE_INTEGER,
      },
      additionalProperties: false,
    },
    verification: {
      type: 'object',
      properties: {
        commands: NON_EMPTY_STRING_ARRAY,
        manifests: NON_EMPTY_STRING_ARRAY,
      },
      additionalProperties: false,
    },
    context: {
      type: 'object',
      properties: { adaptiveBudget: { type: 'boolean' } },
      additionalProperties: false,
    },
    autoUpdates: { type: 'boolean' },
    pricing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string', pattern: PROVIDER_NAME_PATTERN },
          model: { type: 'string', minLength: 1 },
          effectiveFrom: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          inputPerMTok: { type: 'number', minimum: 0 },
          cachedInputPerMTok: { type: 'number', minimum: 0 },
          outputPerMTok: { type: 'number', minimum: 0 },
          currency: { const: 'USD' },
        },
        required: ['provider', 'model', 'effectiveFrom', 'inputPerMTok', 'outputPerMTok', 'currency'],
        additionalProperties: false,
      },
    },
    sandbox: { enum: ['seatbelt', 'bubblewrap', 'none'] },
    telemetry: {
      type: 'object',
      properties: {
        otlp: {
          type: 'object',
          properties: {
            endpoint: { type: 'string', pattern: '^https?://[^\\s]+$' },
            headers: STRING_MAP,
          },
          required: ['endpoint'],
          additionalProperties: false,
        },
        captureMessageContent: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
} as const;

export const MCP_SERVERS_FILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    mcpServers: { type: 'object' },
  },
} as const;
