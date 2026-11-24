import { DEFAULT_SANDBOX_NETWORK, MCP_CONNECT_TIMEOUT_LIMITS, MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS, SANDBOX_NETWORK_SETTINGS, SECRET_NAME_PATTERN, SHUTDOWN_SETTING_LIMITS, STARTUP_TIMEOUT_MS } from '@momonga/foundation';
import { MAX_COST_USD, QUIESCENT_BEHAVIOURS, MANAGED_DECLARABLE_FIELDS, ALLOWED_TOOLS_FORMS, DIALECT_DEFINITION_SCHEMA, ANTHROPIC_API_VERSIONS, HOOK_COMMAND_TYPE, INPUT_CONTENT_KINDS, JSON_MODES, MAX_BUDGET_COUNT, OUTPUT_BOUND_FIELDS, OUTPUT_FORMATTERS, OUTPUT_STYLES, DEFAULT_OUTPUT_STYLE, PERMISSION_MODES, PLAN_LABEL_PATTERN, PROVIDER_NAME_PATTERN, REASONING_EFFORTS, REQUEST_TOOL_KINDS, HOOK_DEFAULT_TIMEOUT_SECONDS, DEFAULT_PERMISSION_MODE, RESPONSES_OUTPUT_BOUNDS, SYSTEM_ROLES, TARGET_ANSWERS, TARGET_BILLINGS, THINKING_OFFS, TOOL_PLACEMENTS, MANAGED_ENDPOINT_FORMS, IDEMPOTENCY_KEY_HEADER_PATTERN, MIN_REQUEST_OUTPUT_TOKENS } from '@momonga/protocol';
import { APPROVAL_DIGEST_PATTERN } from './approval-digest.ts';
import { DEFAULT_UPDATE_STALL_TIMEOUT_MS, defaultContextSettings, defaultMemorySettings, defaultToolsSettings, defaultVerificationSettings } from './context-settings.ts';
import { DEFAULT_AUTO_UPDATES, DEFAULT_CAPTURE_MESSAGE_CONTENT, DEFAULT_ENABLE_ALL_PROJECT_MCP_SERVERS, DEFAULT_NETWORK_ENVIRONMENT, DEFAULT_PLAINTEXT_TOKEN_FILES, DEFAULT_RETENTION_DAYS, FIVE_MINUTES_MS, defaultSandboxSetting, defaultTuiSettings } from './setting-defaults.ts';
import type { ManagedDeclarableField } from '@momonga/protocol';

export const INHERITED_CLASSIFIER = 'inherit';

export const MODEL_ROLES = ['compaction', 'reflection', 'analysis', 'subagent'] as const;

export const BASH_ON_TIMEOUT = ['background', 'kill'] as const;

export const TUI_THEMES = ['auto', 'dark', 'light', 'dark-colorblind', 'light-colorblind'] as const;
export const TUI_NOTIFY_MODES = ['auto', 'bell', 'off'] as const;
export const TUI_SCREEN_MODES = ['fullscreen', 'scrollback'] as const;
export const ISSUE_AUTHOR_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

export const TUI_SETTING_VALUES = { theme: TUI_THEMES, notify: TUI_NOTIFY_MODES, screen: TUI_SCREEN_MODES } as const;

export const SANDBOX_DEFAULT_PLATFORMS = ['darwin', 'linux', 'win32'] as const satisfies readonly NodeJS.Platform[];

export const SETTING_UNITS = { milliseconds: 'milliseconds', seconds: 'seconds', days: 'days', usd: 'USD', usdPerMillionTokens: 'USD per million tokens' } as const;


const MEMORY_DEFAULTS = defaultMemorySettings();
const VERIFICATION_DEFAULTS = defaultVerificationSettings();
const CONTEXT_DEFAULTS = defaultContextSettings();
const TOOLS_DEFAULTS = defaultToolsSettings();
const TUI_DEFAULTS = defaultTuiSettings();
const { default: HOOK_TIMEOUT_DEFAULT_SECONDS, ...HOOK_TIMEOUT_SECONDS_BY_EVENT } = HOOK_DEFAULT_TIMEOUT_SECONDS;

const withDefault = <S extends object, D>(schema: S, value: D) => ({ ...schema, default: value }) as const;

const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;
const NON_EMPTY_STRING_ARRAY = { type: 'array', items: { type: 'string', minLength: 1 } } as const;
const STRING_MAP = { type: 'object', additionalProperties: { type: 'string' } } as const;

export const ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';

const MCP_SERVER_CALL_BOUNDS = {
  timeoutMs: { type: 'integer', minimum: 1 },
  idleTimeoutMs: { type: 'integer', minimum: 0 },
} as const;

export const MCP_SERVER_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'stdio' },
        command: { type: 'string', minLength: 1 },
        args: STRING_ARRAY,
        env: STRING_MAP,
        secretEnv: { type: 'object', propertyNames: { pattern: ENV_NAME_PATTERN }, additionalProperties: { type: 'string', pattern: SECRET_NAME_PATTERN } },
        cwd: { type: 'string' },
        ...MCP_SERVER_CALL_BOUNDS,
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
        ...MCP_SERVER_CALL_BOUNDS,
      },
      required: ['type', 'url'],
      additionalProperties: false,
    },
  ],
} as const;

export const PROVIDER_NAME_PATTERN_SOURCE = PROVIDER_NAME_PATTERN.source;

export const MIN_RETENTION_DAYS = 1;

export const MAX_RETENTION_DAYS = 36500;

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
    items: { type: 'object', properties: { id: MODEL_ID_SCHEMA, ...properties, ...SERVING_PROPERTIES, effort: { type: 'string', enum: [...REASONING_EFFORTS] } }, required: ['id', ...required], additionalProperties: false },
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
    modelFile: { type: 'string', minLength: 1 },
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

const OLLAMA_CAPABILITIES_SCHEMA = targetCapabilitiesSchema(OLLAMA_PROMPT_CACHE, {}, [], []);

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
    profile: { type: 'string', pattern: PLAN_LABEL_PATTERN },
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

const KEY_REQUIRED_ADAPTERS: readonly unknown[] = [ANTHROPIC_CONNECTION_SCHEMA.properties.adapter.const];

const API_KEY_NAMES = Object.keys(API_KEY_PROPERTIES);

export const apiKeyChoiceProblem = (connection: Readonly<Record<string, unknown>>): string | undefined => {
  if (Object.hasOwn(connection, 'plan')) return undefined;
  const given = API_KEY_NAMES.filter((name) => Object.hasOwn(connection, name));
  if (given.length > 1) return `set one of ${API_KEY_NAMES.join(' or ')}, not both`;
  if (given.length === 0 && KEY_REQUIRED_ADAPTERS.includes(connection['adapter'])) return `needs ${API_KEY_NAMES.join(' or ')}`;
  return undefined;
};

const OLLAMA_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    adapter: { const: 'ollama' },
    ...CONNECTION_COMMON_PROPERTIES,
    ...ADDRESS_PROPERTIES,
    models: entriesOf({ capabilities: OLLAMA_CAPABILITIES_SCHEMA }, []),
  },
  required: ['adapter'],
  additionalProperties: false,
} as const;

const MODEL_CONNECTION_SCHEMA = {
  type: 'object',
  oneOf: [MANAGED_CONNECTION_SCHEMA, CHAT_COMPLETIONS_CONNECTION_SCHEMA, OPEN_RESPONSES_CONNECTION_SCHEMA, PLAN_OPEN_RESPONSES_CONNECTION_SCHEMA, ANTHROPIC_CONNECTION_SCHEMA, OLLAMA_CONNECTION_SCHEMA],
} as const;

const MODEL_REFERENCE_SCHEMA = { type: 'string', minLength: 1 } as const;

export type SettingDefaultsBy = { readonly by: 'event' | 'platform'; readonly values: Readonly<Record<string, unknown>> };

export type SettingUnit = (typeof SETTING_UNITS)[keyof typeof SETTING_UNITS];

export const SETTING_UNIT_OF: Readonly<Record<string, SettingUnit>> = {
  'hooks.<name>[].hooks[].timeout': SETTING_UNITS.seconds,
  'mcp.toolIdleTimeoutNetworkMs': SETTING_UNITS.milliseconds,
  'mcp.toolIdleTimeoutStdioMs': SETTING_UNITS.milliseconds,
  'mcp.toolTotalTimeoutMs': SETTING_UNITS.milliseconds,
  'mcp.closeGraceMs': SETTING_UNITS.milliseconds,
  'mcp.connectTimeoutMs': SETTING_UNITS.milliseconds,
  'models.headersTimeoutMs': SETTING_UNITS.milliseconds,
  'models.idleTimeoutMs': SETTING_UNITS.milliseconds,
  'memory.forgetAfterDays': SETTING_UNITS.days,
  'tools.bash.defaultTimeoutMs': SETTING_UNITS.milliseconds,
  'tools.bash.maxTimeoutMs': SETTING_UNITS.milliseconds,
  'tools.bash.backgroundTimeoutMs': SETTING_UNITS.milliseconds,
  'tools.bash.maxBackgroundTimeoutMs': SETTING_UNITS.milliseconds,
  'tools.bash.drainIdleMs': SETTING_UNITS.milliseconds,
  'tools.search.timeoutMs': SETTING_UNITS.milliseconds,
  'tools.operations.timeoutMs': SETTING_UNITS.milliseconds,
  'update.stallTimeoutMs': SETTING_UNITS.milliseconds,
  'daemon.startupStallMs': SETTING_UNITS.milliseconds,
  'gateway.closeGraceMs': SETTING_UNITS.milliseconds,
  'gateway.managedServerStopGraceMs': SETTING_UNITS.milliseconds,
  'runtime.drainTimeoutMs': SETTING_UNITS.milliseconds,
  'pricing[].inputPerMTok': SETTING_UNITS.usdPerMillionTokens,
  'pricing[].cachedInputPerMTok': SETTING_UNITS.usdPerMillionTokens,
  'pricing[].cacheWritePerMTok': SETTING_UNITS.usdPerMillionTokens,
  'pricing[].outputPerMTok': SETTING_UNITS.usdPerMillionTokens,
  'limits.maxCostUsd': SETTING_UNITS.usd,
  'ceilings.costUsd': SETTING_UNITS.usd,
  'ceilings.timeMs': SETTING_UNITS.milliseconds,
  'mandates.<name>.costUsd': SETTING_UNITS.usd,
  'mandates.<name>.timeMs': SETTING_UNITS.milliseconds,
  'mcpServers.<name>.timeoutMs': SETTING_UNITS.milliseconds,
  'mcpServers.<name>.idleTimeoutMs': SETTING_UNITS.milliseconds,
  'retention.days': SETTING_UNITS.days,
};

export const SETTING_DEFAULTS_BY: Readonly<Record<string, SettingDefaultsBy>> = {
  'hooks.<name>[].hooks[].timeout': { by: 'event', values: HOOK_TIMEOUT_SECONDS_BY_EVENT },
  sandbox: { by: 'platform', values: Object.fromEntries(SANDBOX_DEFAULT_PLATFORMS.map((platform) => [platform, defaultSandboxSetting(platform)])) },
};

const HOOK_COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    type: { const: HOOK_COMMAND_TYPE },
    command: { type: 'string', minLength: 1 },
    timeout: { ...POSITIVE_INTEGER, default: HOOK_TIMEOUT_DEFAULT_SECONDS },
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
        defaultMode: { type: 'string', enum: [...PERMISSION_MODES], default: DEFAULT_PERMISSION_MODE },
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
      properties: { env: NON_EMPTY_STRING_ARRAY, keep: NON_EMPTY_STRING_ARRAY, valuePatterns: NON_EMPTY_STRING_ARRAY, plaintextTokenFiles: { type: 'boolean', default: DEFAULT_PLAINTEXT_TOKEN_FILES } },
      additionalProperties: false,
    },
    hooks: { type: 'object', additionalProperties: { type: 'array', items: HOOK_MATCHER_GROUP_SCHEMA } },
    autoMode: {
      type: 'object',
      properties: { classifier: { type: 'string', minLength: 1, default: INHERITED_CLASSIFIER } },
      additionalProperties: false,
    },
    enabledMcpjsonServers: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object', properties: { name: { type: 'string', minLength: 1 }, digest: { type: 'string', pattern: APPROVAL_DIGEST_PATTERN }, config: {} }, required: ['name', 'digest'], additionalProperties: false },
        ],
      },
    },
    disabledMcpjsonServers: STRING_ARRAY,
    enableAllProjectMcpServers: { type: 'boolean', default: DEFAULT_ENABLE_ALL_PROJECT_MCP_SERVERS },
    mcpServers: { type: 'object', additionalProperties: MCP_SERVER_SCHEMA },
    mcp: {
      type: 'object',
      properties: {
        toolIdleTimeoutNetworkMs: withDefault(NON_NEGATIVE_INTEGER, MCP_TOOL_IDLE_TIMEOUT_MS.network),
        toolIdleTimeoutStdioMs: withDefault(NON_NEGATIVE_INTEGER, MCP_TOOL_IDLE_TIMEOUT_MS.stdio),
        toolTotalTimeoutMs: withDefault(POSITIVE_INTEGER, MCP_TOOL_TOTAL_TIMEOUT_MS),
        closeGraceMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.min, maximum: SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.max, default: SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.default },
        connectTimeoutMs: { type: 'integer', minimum: MCP_CONNECT_TIMEOUT_LIMITS.min, maximum: MCP_CONNECT_TIMEOUT_LIMITS.max, default: MCP_CONNECT_TIMEOUT_LIMITS.default },
      },
      additionalProperties: false,
    },
    models: {
      type: 'object',
      properties: {
        connections: { type: 'array', items: MODEL_CONNECTION_SCHEMA },
        start: MODEL_REFERENCE_SCHEMA,
        effort: { type: 'string', enum: [...REASONING_EFFORTS] },
        fallback: { type: 'array', items: MODEL_REFERENCE_SCHEMA },
        servers: {
          type: 'object',
          propertyNames: { pattern: PROVIDER_NAME_PATTERN_SOURCE },
          additionalProperties: DECLARED_SERVER_SCHEMA,
        },
        dialects: { type: 'object', additionalProperties: DIALECT_DEFINITION_SCHEMA },
        headersTimeoutMs: withDefault(POSITIVE_INTEGER, FIVE_MINUTES_MS),
        idleTimeoutMs: withDefault(POSITIVE_INTEGER, FIVE_MINUTES_MS),
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
          properties: { enabled: { type: 'boolean', default: MEMORY_DEFAULTS.reflection.enabled }, maxTokens: OUTPUT_TOKEN_BOUND },
          additionalProperties: false,
        },
        forgetAfterDays: { ...POSITIVE_INTEGER, default: MEMORY_DEFAULTS.forgetAfterDays },
        repositoryFacts: { type: 'boolean', default: MEMORY_DEFAULTS.repositoryFacts },
      },
      additionalProperties: false,
    },
    verification: {
      type: 'object',
      properties: {
        commands: NON_EMPTY_STRING_ARRAY,
        manifests: withDefault(NON_EMPTY_STRING_ARRAY, VERIFICATION_DEFAULTS.manifests),
        required: { type: 'boolean', default: VERIFICATION_DEFAULTS.required },
      },
      additionalProperties: false,
    },
    context: {
      type: 'object',
      properties: {
        adaptiveBudget: { type: 'boolean', default: CONTEXT_DEFAULTS.adaptiveBudget },
        autoCompact: { type: 'boolean', default: CONTEXT_DEFAULTS.autoCompact },
        cachePrefix: { type: 'boolean', default: CONTEXT_DEFAULTS.cachePrefix },
        outputFormatters: { type: 'array', items: { enum: [...OUTPUT_FORMATTERS] }, default: CONTEXT_DEFAULTS.outputFormatters },
        loopGuidance: { type: 'boolean', default: CONTEXT_DEFAULTS.loopGuidance },
        observedCapacity: { type: 'boolean', default: CONTEXT_DEFAULTS.observedCapacity },
        unboundedOutputReserve: { type: 'boolean', default: CONTEXT_DEFAULTS.unboundedOutputReserve },
      },
      additionalProperties: false,
    },
    tools: {
      type: 'object',
      properties: {
        deferral: { type: 'boolean', default: TOOLS_DEFAULTS.deferral },
        conciseDescriptions: { type: 'boolean', default: TOOLS_DEFAULTS.conciseDescriptions },
        ripgrep: { type: 'string', minLength: 1, default: TOOLS_DEFAULTS.ripgrep },
        bash: {
          type: 'object',
          properties: {
            defaultTimeoutMs: withDefault(POSITIVE_INTEGER, TOOLS_DEFAULTS.bash.defaultTimeoutMs),
            maxTimeoutMs: withDefault(POSITIVE_INTEGER, TOOLS_DEFAULTS.bash.maxTimeoutMs),
            onTimeout: { enum: [...BASH_ON_TIMEOUT], default: TOOLS_DEFAULTS.bash.onTimeout },
            backgroundTimeoutMs: withDefault(POSITIVE_INTEGER, TOOLS_DEFAULTS.bash.backgroundTimeoutMs),
            maxBackgroundTimeoutMs: withDefault(POSITIVE_INTEGER, TOOLS_DEFAULTS.bash.maxBackgroundTimeoutMs),
            drainIdleMs: withDefault(POSITIVE_INTEGER, TOOLS_DEFAULTS.bash.drainIdleMs),
          },
          additionalProperties: false,
        },
        search: { type: 'object', properties: { timeoutMs: withDefault(POSITIVE_INTEGER, TOOLS_DEFAULTS.search.timeoutMs) }, additionalProperties: false },
        operations: { type: 'object', properties: { timeoutMs: withDefault(POSITIVE_INTEGER, TOOLS_DEFAULTS.operations.timeoutMs) }, additionalProperties: false },
      },
      additionalProperties: false,
    },
    autoUpdates: { type: 'boolean', default: DEFAULT_AUTO_UPDATES },
    update: { type: 'object', properties: { stallTimeoutMs: withDefault(POSITIVE_INTEGER, DEFAULT_UPDATE_STALL_TIMEOUT_MS) }, additionalProperties: false },
    daemon: { type: 'object', properties: { startupStallMs: { ...POSITIVE_INTEGER, default: STARTUP_TIMEOUT_MS } }, additionalProperties: false },
    tui: {
      type: 'object',
      properties: {
        theme: { enum: [...TUI_THEMES], default: TUI_DEFAULTS.theme },
        notify: { enum: [...TUI_NOTIFY_MODES], default: TUI_DEFAULTS.notify },
        screenReader: { type: 'boolean', default: TUI_DEFAULTS.screenReader },
        reducedMotion: { type: 'boolean', default: TUI_DEFAULTS.reducedMotion },
        screen: { enum: [...TUI_SCREEN_MODES], default: TUI_DEFAULTS.screen },
        mouse: { type: 'boolean', default: TUI_DEFAULTS.mouse },
        copyOnSelect: { type: 'boolean', default: TUI_DEFAULTS.copyOnSelect },
        attachFileMentions: { type: 'boolean', default: TUI_DEFAULTS.attachFileMentions },
      },
      additionalProperties: false,
    },
    gateway: {
      type: 'object',
      properties: {
        closeGraceMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.closeGraceMs.min, maximum: SHUTDOWN_SETTING_LIMITS.closeGraceMs.max, default: SHUTDOWN_SETTING_LIMITS.closeGraceMs.default },
        managedServerStopGraceMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.managedServerStopGraceMs.min, maximum: SHUTDOWN_SETTING_LIMITS.managedServerStopGraceMs.max, default: SHUTDOWN_SETTING_LIMITS.managedServerStopGraceMs.default },
      },
      additionalProperties: false,
    },
    runtime: {
      type: 'object',
      properties: {
        drainTimeoutMs: { type: 'integer', minimum: SHUTDOWN_SETTING_LIMITS.drainTimeoutMs.min, maximum: SHUTDOWN_SETTING_LIMITS.drainTimeoutMs.max, default: SHUTDOWN_SETTING_LIMITS.drainTimeoutMs.default },
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
        environment: { type: 'boolean', default: DEFAULT_NETWORK_ENVIRONMENT },
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
    issues: {
      type: 'object',
      properties: {
        watch: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
              folder: { type: 'string', minLength: 1 },
              forge: { type: 'string', minLength: 1 },
              labels: NON_EMPTY_STRING_ARRAY,
              authorAssociation: { type: 'array', items: { enum: [...ISSUE_AUTHOR_ASSOCIATIONS] } },
              mandate: { type: 'string', minLength: 1 },
            },
            required: ['repository', 'folder', 'forge', 'mandate'],
            additionalProperties: false,
          },
        },
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
          hosts: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          apiBaseUrl: { type: 'string', minLength: 1 },
          credential: {
            type: 'object',
            properties: { env: { type: 'string', pattern: ENV_NAME_PATTERN }, secret: { type: 'string', pattern: SECRET_NAME_PATTERN } },
            minProperties: 1,
            maxProperties: 1,
            additionalProperties: false,
          },
        },
        required: ['id', 'descriptor', 'hosts', 'apiBaseUrl', 'credential'],
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
    sandboxNetwork: { enum: [...SANDBOX_NETWORK_SETTINGS], default: DEFAULT_SANDBOX_NETWORK },
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
        captureMessageContent: { type: 'boolean', default: DEFAULT_CAPTURE_MESSAGE_CONTENT },
      },
      additionalProperties: false,
    },
    projectApprovals: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          hooks: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string', pattern: APPROVAL_DIGEST_PATTERN },
                { type: 'object', properties: { digest: { type: 'string', pattern: APPROVAL_DIGEST_PATTERN }, event: { type: 'string', minLength: 1 }, group: {} }, required: ['digest', 'event', 'group'], additionalProperties: false },
              ],
            },
          },
          mandate: {
            oneOf: [
              { type: 'string', pattern: APPROVAL_DIGEST_PATTERN },
              { type: 'object', properties: { digest: { type: 'string', pattern: APPROVAL_DIGEST_PATTERN }, document: {} }, required: ['digest', 'document'], additionalProperties: false },
            ],
          },
          agents: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, digest: { type: 'string', pattern: APPROVAL_DIGEST_PATTERN }, text: { type: 'string' } }, required: ['name', 'digest', 'text'], additionalProperties: false },
          },
        },
        additionalProperties: false,
      },
    },
    projectChecks: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          { type: 'object', properties: { commands: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } }, required: ['commands'], additionalProperties: false },
          { type: 'object', properties: { declined: { const: true } }, required: ['declined'], additionalProperties: false },
        ],
      },
    },
    retention: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: MIN_RETENTION_DAYS, maximum: MAX_RETENTION_DAYS, default: DEFAULT_RETENTION_DAYS } },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { style: { enum: [...OUTPUT_STYLES], default: DEFAULT_OUTPUT_STYLE } },
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
