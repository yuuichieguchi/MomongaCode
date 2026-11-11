import { MCP_CONNECT_TIMEOUT_LIMITS, SANDBOX_NETWORK_SETTINGS, SECRET_NAME_PATTERN, SHUTDOWN_SETTING_LIMITS } from '@momonga/foundation';
import { MAX_COST_USD, QUIESCENT_BEHAVIOURS, MANAGED_DECLARABLE_FIELDS, ALLOWED_TOOLS_FORMS, DIALECT_DEFINITION_SCHEMA, ANTHROPIC_API_VERSIONS, HOOK_COMMAND_TYPE, INPUT_CONTENT_KINDS, JSON_MODES, MAX_BUDGET_COUNT, OUTPUT_BOUND_FIELDS, OUTPUT_FORMATTERS, PERMISSION_MODES, PLAN_LABEL_PATTERN, PROVIDER_NAME_PATTERN, REASONING_EFFORTS, REQUEST_TOOL_KINDS, RESPONSES_OUTPUT_BOUNDS, SYSTEM_ROLES, TARGET_ANSWERS, TARGET_BILLINGS, THINKING_OFFS, TOOL_PLACEMENTS, MANAGED_ENDPOINT_FORMS, IDEMPOTENCY_KEY_HEADER_PATTERN, MIN_REQUEST_OUTPUT_TOKENS } from '@momonga/protocol';
import type { CallRole, ManagedDeclarableField } from '@momonga/protocol';

export const MODEL_ROLES = ['compaction', 'reflection', 'analysis'] as const satisfies readonly CallRole[];

export const TUI_THEMES = ['auto', 'dark', 'light', 'dark-colorblind', 'light-colorblind'] as const;
export const TUI_NOTIFY_MODES = ['off', 'bell'] as const;
export const TUI_SCREEN_MODES = ['fullscreen', 'scrollback'] as const;
export const TUI_SETTING_VALUES = { theme: TUI_THEMES, notify: TUI_NOTIFY_MODES, screen: TUI_SCREEN_MODES } as const;

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

export const ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';
export const PROVIDER_NAME_PATTERN_SOURCE = PROVIDER_NAME_PATTERN.source;

const POSITIVE_INTEGER = { type: 'integer', minimum: 1 } as const;
const OUTPUT_TOKEN_BOUND = { type: 'integer', minimum: MIN_REQUEST_OUTPUT_TOKENS } as const;
const NON_NEGATIVE_INTEGER = { type: 'integer', minimum: 0 } as const;

const OUTPUT_BOUND_FIELD_SCHEMA = { enum: [...OUTPUT_BOUND_FIELDS] } as const;

const RESPONSES_OUTPUT_BOUND_SCHEMA = { enum: [...RESPONSES_OUTPUT_BOUNDS] } as const;

const ROUTE_CARRIAGE_PROPERTIES = {
  outputBoundField: RESPONSES_OUTPUT_BOUND_SCHEMA,
  systemRole: { enum: [...SYSTEM_ROLES] },
  toolPlacement: { enum: [...TOOL_PLACEMENTS] },
  inputKinds: {
    type: 'object',
    properties: {
      content: { type: 'array', items: { enum: [...INPUT_CONTENT_KINDS] }, uniqueItems: true },
      tools: { type: 'array', items: { enum: [...REQUEST_TOOL_KINDS] }, uniqueItems: true },
    },
    required: ['content', 'tools'],
    additionalProperties: false,
  },
} as const;

const ANSWERS_SCHEMA = { enum: [...TARGET_ANSWERS] } as const;

export const READY_TIMEOUT_LIMITS = { min: 1, max: 300_000 } as const;

const MANAGED_DECLARABLE_SCHEMAS: Record<ManagedDeclarableField, object> = {
  contextWindow: { type: 'integer', minimum: 1, maximum: MAX_BUDGET_COUNT },
  maxOutputTokens: OUTPUT_TOKEN_BOUND,
};

const MODEL_ID_SCHEMA = { type: 'string', minLength: 1 } as const;

const PROVIDER_SCHEMA = { type: 'string', minLength: 1 } as const;

const BILLING_SCHEMA = { enum: [...TARGET_BILLINGS] } as const;

const SERVING_PROPERTIES = { maxConcurrency: POSITIVE_INTEGER, admissionTimeoutMs: NON_NEGATIVE_INTEGER } as const;

const IDEMPOTENCY_KEY_HEADER_SCHEMA = { type: 'string', pattern: IDEMPOTENCY_KEY_HEADER_PATTERN } as const;

const CONNECTION_COMMON_PROPERTIES = { provider: PROVIDER_SCHEMA, answers: ANSWERS_SCHEMA, billing: BILLING_SCHEMA, idempotencyKeyHeader: IDEMPOTENCY_KEY_HEADER_SCHEMA, ...SERVING_PROPERTIES } as const;

const entriesOf = (properties: object, required: readonly string[]) =>
  ({
    type: 'array',
    items: { type: 'object', properties: { id: MODEL_ID_SCHEMA, ...properties, ...SERVING_PROPERTIES }, required: ['id', ...required], additionalProperties: false },
  }) as const;

const MANAGED_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'managed' },
    ...CONNECTION_COMMON_PROPERTIES,
    server: { type: 'string', minLength: 1 },
    binary: { type: 'string', minLength: 1 },
    readyTimeoutMs: { type: 'integer', minimum: READY_TIMEOUT_LIMITS.min, maximum: READY_TIMEOUT_LIMITS.max },
    models: entriesOf(
      {
        toolCalling: { enum: ['auto', 'native', 'constrained'] },
        outputBoundField: OUTPUT_BOUND_FIELD_SCHEMA,
        capabilities: {
          type: 'object',
          properties: Object.fromEntries(MANAGED_DECLARABLE_FIELDS.map((field) => [field, MANAGED_DECLARABLE_SCHEMAS[field]])),
          required: [...MANAGED_DECLARABLE_FIELDS],
          additionalProperties: false,
        },
      },
      [],
    ),
  },
  required: ['adapter', 'server'],
  additionalProperties: false,
} as const;

const DECLARED_SERVER_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1 },
    args: { type: 'array', items: { type: 'string' } },
    readyPath: { type: 'string', pattern: '^/' },
    endpoint: {
      type: 'object',
      properties: { forms: { type: 'array', items: { type: 'string', enum: MANAGED_ENDPOINT_FORMS }, minItems: 1, uniqueItems: true } },
      required: ['forms'],
      additionalProperties: false,
    },
  },
  required: ['command', 'args', 'readyPath'],
  additionalProperties: false,
} as const;

const BREAKPOINTS_PROMPT_CACHE = {
  type: 'object',
  properties: { kind: { const: 'breakpoints' }, maxBreakpoints: POSITIVE_INTEGER },
  required: ['kind', 'maxBreakpoints'],
  additionalProperties: false,
} as const;

const promptCacheOf = (kinds: readonly ('key' | 'automatic' | 'none')[]) =>
  ({ type: 'object', properties: { kind: { enum: [...kinds] } }, required: ['kind'], additionalProperties: false }) as const;

const ANTHROPIC_PROMPT_CACHE = { oneOf: [BREAKPOINTS_PROMPT_CACHE, promptCacheOf(['none'])] } as const;

const KEYED_PROMPT_CACHE = promptCacheOf(['key', 'automatic', 'none']);

const OLLAMA_PROMPT_CACHE = promptCacheOf(['automatic', 'none']);

const MIN_THINKING_BUDGET = 1024;

const THINKING_ADAPTIVE_EFFORTS = REASONING_EFFORTS.filter((effort) => effort !== 'none' && effort !== 'minimal');

const THINKING_BUDGET_EFFORTS = REASONING_EFFORTS.filter((effort) => effort !== 'none');

const THINKING_OFF_SCHEMA = { enum: [...THINKING_OFFS] } as const;

const THINKING_REASONING_SCHEMAS = [
  {
    type: 'object',
    properties: {
      control: { const: 'thinking' },
      form: { const: 'adaptive' },
      efforts: { type: 'array', items: { enum: THINKING_ADAPTIVE_EFFORTS }, minItems: 1, uniqueItems: true },
      off: THINKING_OFF_SCHEMA,
    },
    required: ['control', 'form', 'efforts'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      control: { const: 'thinking' },
      form: { const: 'budget' },
      budgets: {
        type: 'object',
        properties: Object.fromEntries(THINKING_BUDGET_EFFORTS.map((effort) => [effort, { type: 'integer', minimum: MIN_THINKING_BUDGET }])),
        minProperties: 1,
        additionalProperties: false,
      },
      off: THINKING_OFF_SCHEMA,
    },
    required: ['control', 'form', 'budgets'],
    additionalProperties: false,
  },
] as const;

const UNIT_INTERVAL = { type: 'number', minimum: 0, maximum: 1 } as const;

const SAMPLING_SCHEMA = {
  oneOf: [
    { type: 'object', properties: { accepts: { const: 'none' } }, required: ['accepts'], additionalProperties: false },
    { type: 'object', properties: { accepts: { const: 'free' } }, required: ['accepts'], additionalProperties: false },
    {
      type: 'object',
      properties: {
        accepts: { const: 'without_thinking' },
        topP: { type: 'object', properties: { min: UNIT_INTERVAL, max: UNIT_INTERVAL }, required: ['min', 'max'], additionalProperties: false },
      },
      required: ['accepts', 'topP'],
      additionalProperties: false,
    },
  ],
} as const;

const targetCapabilitiesSchema = (promptCache: object, extraProperties: object = {}, extraReasoning: readonly object[] = [], required: readonly string[] = ['contextWindow', 'maxOutputTokens']) =>
  ({
  type: 'object',
  properties: {
    ...extraProperties,
    contextWindow: { type: 'integer', minimum: 1, maximum: MAX_BUDGET_COUNT },
    maxOutputTokens: OUTPUT_TOKEN_BOUND,
    structuredOutput: { enum: ['json_schema', 'none'] },
    jsonMode: { enum: [...JSON_MODES] },
    streaming: { type: 'boolean' },
    stopSequences: { type: 'boolean' },
    imageInput: { type: 'boolean' },
    imageTokens: {
      type: 'object',
      properties: { pixelsPerToken: { type: 'number', exclusiveMinimum: 0 }, maxTokens: POSITIVE_INTEGER, minTokens: POSITIVE_INTEGER },
      required: ['pixelsPerToken', 'maxTokens', 'minTokens'],
      additionalProperties: false,
    },
    parallelToolCalls: { type: 'boolean' },
    allowedTools: { type: 'array', items: { enum: [...ALLOWED_TOOLS_FORMS] }, minItems: 1, uniqueItems: true },
    schemaDialect: { type: 'string', minLength: 1 },
    tokenCounting: { enum: ['exact', 'calibrated', 'estimated'] },
    tokenErrorRatio: { type: 'number', minimum: 0 },
    usageReported: { type: 'boolean' },
    reasoning: {
      oneOf: [
        {
          type: 'object',
          properties: { control: { const: 'none' }, headroomTokens: NON_NEGATIVE_INTEGER },
          required: ['control'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { control: { const: 'reasoning_effort' }, lowest: { enum: [...REASONING_EFFORTS] } },
          required: ['control', 'lowest'],
          additionalProperties: false,
        },
        ...extraReasoning,
      ],
    },
    promptCache: promptCache,
    sampling: SAMPLING_SCHEMA,
    source: { enum: ['declared', 'probed', 'config', 'unprobed'] },
  },
  required: [...required],
  additionalProperties: false,
}) as const;

const ANTHROPIC_CAPABILITIES_SCHEMA = targetCapabilitiesSchema(ANTHROPIC_PROMPT_CACHE, {}, THINKING_REASONING_SCHEMAS);

const KEYED_CAPABILITIES_SCHEMA = targetCapabilitiesSchema(KEYED_PROMPT_CACHE, ROUTE_CARRIAGE_PROPERTIES);

const PLAN_CAPABILITIES_SCHEMA = targetCapabilitiesSchema(KEYED_PROMPT_CACHE, ROUTE_CARRIAGE_PROPERTIES, [], []);

const CHAT_COMPLETIONS_CAPABILITIES_SCHEMA = targetCapabilitiesSchema(KEYED_PROMPT_CACHE, { outputBoundField: OUTPUT_BOUND_FIELD_SCHEMA });

const OLLAMA_CAPABILITIES_SCHEMA = targetCapabilitiesSchema(OLLAMA_PROMPT_CACHE);

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

const ADDRESS_PROPERTIES = { baseUrl: { type: 'string', minLength: 1 }, socketPath: { type: 'string', minLength: 1 } } as const;

const CHAT_COMPLETIONS_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'chat-completions' },
    ...CONNECTION_COMMON_PROPERTIES,
    ...ADDRESS_PROPERTIES,
    ...API_KEY_PROPERTIES,
    models: entriesOf({ toolCalling: { enum: ['auto', 'native', 'constrained'] }, capabilities: CHAT_COMPLETIONS_CAPABILITIES_SCHEMA }, ['capabilities']),
  },
  required: ['adapter'],
  ...AT_MOST_ONE_API_KEY,
  additionalProperties: false,
} as const;

const OPEN_RESPONSES_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'open-responses' },
    ...CONNECTION_COMMON_PROPERTIES,
    ...ADDRESS_PROPERTIES,
    ...API_KEY_PROPERTIES,
    models: entriesOf({ toolCalling: { enum: ['native', 'none'] }, capabilities: KEYED_CAPABILITIES_SCHEMA }, ['capabilities']),
  },
  required: ['adapter'],
  ...AT_MOST_ONE_API_KEY,
  additionalProperties: false,
} as const;

const PLAN_REFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    profile: { type: 'string', minLength: 1 },
    account: { type: 'string', pattern: PLAN_LABEL_PATTERN },
  },
  required: ['profile'],
  additionalProperties: false,
} as const;

const PLAN_OPEN_RESPONSES_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'open-responses' },
    ...CONNECTION_COMMON_PROPERTIES,
    ...ADDRESS_PROPERTIES,
    ...API_KEY_PROPERTIES,
    plan: PLAN_REFERENCE_SCHEMA,
    models: entriesOf({ toolCalling: { enum: ['native', 'none'] }, capabilities: PLAN_CAPABILITIES_SCHEMA }, []),
  },
  required: ['adapter', 'plan'],
  additionalProperties: false,
} as const;

const ANTHROPIC_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'anthropic' },
    ...CONNECTION_COMMON_PROPERTIES,
    ...ADDRESS_PROPERTIES,
    ...API_KEY_PROPERTIES,
    apiVersion: { enum: [...ANTHROPIC_API_VERSIONS] },
    models: entriesOf({ capabilities: ANTHROPIC_CAPABILITIES_SCHEMA }, ['capabilities']),
  },
  required: ['adapter'],
  ...EXACTLY_ONE_API_KEY,
  additionalProperties: false,
} as const;

const OLLAMA_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'ollama' },
    ...CONNECTION_COMMON_PROPERTIES,
    ...ADDRESS_PROPERTIES,
    models: entriesOf({ capabilities: OLLAMA_CAPABILITIES_SCHEMA }, ['capabilities']),
  },
  required: ['adapter'],
  additionalProperties: false,
} as const;

const MODEL_CONNECTION_SCHEMA = {
  type: 'object',
  oneOf: [MANAGED_CONNECTION_SCHEMA, CHAT_COMPLETIONS_CONNECTION_SCHEMA, OPEN_RESPONSES_CONNECTION_SCHEMA, PLAN_OPEN_RESPONSES_CONNECTION_SCHEMA, ANTHROPIC_CONNECTION_SCHEMA, OLLAMA_CONNECTION_SCHEMA],
} as const;

const MODEL_REFERENCE_SCHEMA = { type: 'string', minLength: 1 } as const;

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
    credentials: {
      type: 'object',
      properties: { env: NON_EMPTY_STRING_ARRAY, keep: NON_EMPTY_STRING_ARRAY, valuePatterns: NON_EMPTY_STRING_ARRAY, plaintextTokenFiles: { type: 'boolean' } },
      additionalProperties: false,
    },
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
    mcp: {
      type: 'object',
      properties: {
        toolIdleTimeoutMs: NON_NEGATIVE_INTEGER,
        toolTotalTimeoutMs: POSITIVE_INTEGER,
        closeGraceMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.min, maximum: SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.max },
        connectTimeoutMs: { type: 'integer', minimum: MCP_CONNECT_TIMEOUT_LIMITS.min, maximum: MCP_CONNECT_TIMEOUT_LIMITS.max },
      },
      additionalProperties: false,
    },
    models: {
      type: 'object',
      properties: {
        connections: { type: 'array', items: MODEL_CONNECTION_SCHEMA },
        start: MODEL_REFERENCE_SCHEMA,
        fallback: { type: 'array', items: MODEL_REFERENCE_SCHEMA },
        servers: {
          type: 'object',
          propertyNames: { pattern: PROVIDER_NAME_PATTERN_SOURCE },
          additionalProperties: DECLARED_SERVER_SCHEMA,
        },
        dialects: { type: 'object', additionalProperties: DIALECT_DEFINITION_SCHEMA },
        headersTimeoutMs: NON_NEGATIVE_INTEGER,
        idleTimeoutMs: NON_NEGATIVE_INTEGER,
        billingChanges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: BILLING_SCHEMA,
              to: BILLING_SCHEMA,
              model: MODEL_REFERENCE_SCHEMA,
            },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
        roles: {
          type: 'object',
          properties: Object.fromEntries(MODEL_ROLES.map((role) => [role, { type: 'string', minLength: 1 }])),
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    memory: {
      type: 'object',
      properties: {
        reflection: {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, maxTokens: OUTPUT_TOKEN_BOUND },
          additionalProperties: false,
        },
        forgetAfterDays: POSITIVE_INTEGER,
        repositoryFacts: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    verification: {
      type: 'object',
      properties: {
        commands: NON_EMPTY_STRING_ARRAY,
        manifests: NON_EMPTY_STRING_ARRAY,
        required: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    context: {
      type: 'object',
      properties: {
        adaptiveBudget: { type: 'boolean' },
        autoCompact: { type: 'boolean' },
        cachePrefix: { type: 'boolean' },
        outputFormatters: { type: 'array', items: { enum: [...OUTPUT_FORMATTERS] } },
        loopGuidance: { type: 'boolean' },
        observedCapacity: { type: 'boolean' },
        unboundedOutputReserve: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    tools: {
      type: 'object',
      properties: { deferral: { type: 'boolean' }, conciseDescriptions: { type: 'boolean' }, ripgrep: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    autoUpdates: { type: 'boolean' },
    tui: {
      type: 'object',
      properties: { theme: { enum: [...TUI_THEMES] }, notify: { enum: [...TUI_NOTIFY_MODES] }, screenReader: { type: 'boolean' }, reducedMotion: { type: 'boolean' }, screen: { enum: [...TUI_SCREEN_MODES] }, mouse: { type: 'boolean' }, copyOnSelect: { type: 'boolean' }, attachFileMentions: { type: 'boolean' } },
      additionalProperties: false,
    },
    gateway: {
      type: 'object',
      properties: {
        closeGraceMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.closeGraceMs.min, maximum: SHUTDOWN_SETTING_LIMITS.closeGraceMs.max },
        managedServerStopGraceMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.managedServerStopGraceMs.min, maximum: SHUTDOWN_SETTING_LIMITS.managedServerStopGraceMs.max },
      },
      additionalProperties: false,
    },
    runtime: {
      type: 'object',
      properties: {
        drainTimeoutMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.drainTimeoutMs.min, maximum: SHUTDOWN_SETTING_LIMITS.drainTimeoutMs.max },
      },
      additionalProperties: false,
    },
    network: {
      type: 'object',
      properties: {
        httpProxy: { type: 'string', minLength: 1 },
        httpsProxy: { type: 'string', minLength: 1 },
        noProxy: { type: 'string', minLength: 1 },
        extraCaFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
        environment: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    pricing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string', pattern: PROVIDER_NAME_PATTERN_SOURCE },
          model: { type: 'string', minLength: 1 },
          effectiveFrom: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          inputPerMTok: { type: 'number', minimum: 0 },
          cachedInputPerMTok: { type: 'number', minimum: 0 },
          cacheWritePerMTok: { type: 'number', minimum: 0 },
          outputPerMTok: { type: 'number', minimum: 0 },
          currency: { const: 'USD' },
        },
        required: ['provider', 'model', 'effectiveFrom', 'inputPerMTok', 'outputPerMTok', 'currency'],
        additionalProperties: false,
      },
    },
    limits: {
      type: 'object',
      properties: { maxCostUsd: { type: 'number', minimum: 0, maximum: MAX_COST_USD } },
      additionalProperties: false,
    },
    ceilings: {
      type: 'object',
      properties: {
        costUsd: { type: 'number', minimum: 0, maximum: MAX_COST_USD },
        tokens: { type: 'integer', minimum: 1, maximum: 100_000_000 },
        timeMs: { type: 'integer', minimum: 1000, maximum: 604_800_000 },
      },
      additionalProperties: false,
    },
    mandates: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          allow: NON_EMPTY_STRING_ARRAY,
          ask: NON_EMPTY_STRING_ARRAY,
          deny: NON_EMPTY_STRING_ARRAY,
          until: NON_EMPTY_STRING_ARRAY,
          require: NON_EMPTY_STRING_ARRAY,
          steps: { type: 'integer', minimum: 1, maximum: 1000 },
          tokens: { type: 'integer', minimum: 1, maximum: 100_000_000 },
          costUsd: { type: 'number', minimum: 0, maximum: MAX_COST_USD },
          timeMs: { type: 'integer', minimum: 1000, maximum: 604_800_000 },
          retries: { type: 'integer', minimum: 1, maximum: 100 },
          onQuiescent: { enum: [...QUIESCENT_BEHAVIOURS] },
        },
        additionalProperties: false,
      },
    },
    forges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          descriptor: { type: 'string', minLength: 1 },
          host: { type: 'string', minLength: 1 },
          apiBaseUrl: { type: 'string', minLength: 1 },
          credentialEnv: { type: 'string', pattern: ENV_NAME_PATTERN },
          credentialSecret: { type: 'string', pattern: SECRET_NAME_PATTERN },
        },
        required: ['id', 'descriptor', 'host', 'apiBaseUrl'],
        additionalProperties: false,
      },
    },
    operations: {
      type: 'object',
      properties: {
        protectedRefs: NON_EMPTY_STRING_ARRAY,
        approval: { type: 'object', additionalProperties: { type: 'string', enum: ['rule', 'always'] } },
      },
      additionalProperties: false,
    },
    sandbox: { enum: ['seatbelt', 'bubblewrap', 'none'] },
    sandboxNetwork: { enum: [...SANDBOX_NETWORK_SETTINGS] },
    sandboxUnixSockets: { type: 'object', properties: { allow: { type: 'array', items: { type: 'string', minLength: 1 } } }, additionalProperties: false },
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
        contentRetentionDays: POSITIVE_INTEGER,
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
