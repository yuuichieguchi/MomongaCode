export type JsonCheck = { path: string[]; is: 'string' | 'number' | 'array' | 'object' } | { path: string[]; eachHas: string[]; atLeastOne: true };

export type ServerKindAdapter = 'ollama' | 'chat-completions' | 'open-responses' | 'anthropic';

export type ServerKindRecognise = { requests: { method: 'GET'; path: string; expect: JsonCheck[] }[] };

export type ServerKindRead = {
  list: { path: string; array: string; id: string; filter?: { field: string; equals: string } };
  window?: string;
  ceiling?: string;
  tools?: 'unknown';
  details?: { method: 'POST'; path: string; body: { model: '$id' }; tools: string; ceilingTemplate: string };
};

export type ServerKind = {
  kind: string;
  label: string;
  adapterLabel: string;
  adapter: ServerKindAdapter;
  impliedByAdapter?: ServerKindAdapter;
  address?: { host: string; port: number };
  baseUrlSuffix: string;
  settings: { billing?: 'local'; maxConcurrency?: number };
  defaultTag?: string;
  recognise?: ServerKindRecognise;
  read?: ServerKindRead;
};

export type ServerKinds = readonly ServerKind[];

export const GENERIC_SERVER_KIND = 'generic';

export const SERVER_ADAPTER_LABELS: Readonly<Record<ServerKindAdapter, string>> = {
  ollama: 'Ollama API',
  'chat-completions': 'OpenAI-compatible API',
  anthropic: 'Anthropic API',
  'open-responses': 'OpenAI Responses API',
};

export const SERVER_KINDS: ServerKinds = [
  {
    kind: 'ollama',
    label: 'Ollama',
    adapterLabel: 'the Ollama API',
    adapter: 'ollama',
    impliedByAdapter: 'ollama',
    address: { host: '127.0.0.1', port: 11434 },
    baseUrlSuffix: '',
    settings: {},
    defaultTag: 'latest',
    recognise: {
      requests: [
        { method: 'GET', path: '/api/version', expect: [{ path: ['version'], is: 'string' }] },
        { method: 'GET', path: '/api/tags', expect: [{ path: ['models'], is: 'array' }] },
      ],
    },
    read: {
      list: { path: '/api/tags', array: 'models', id: 'name' },
      details: { method: 'POST', path: '/api/show', body: { model: '$id' }, tools: 'capabilities', ceilingTemplate: 'model_info.<general.architecture>.context_length' },
    },
  },
  {
    kind: 'lmstudio',
    label: 'LM Studio',
    adapterLabel: 'the OpenAI-compatible API',
    adapter: 'chat-completions',
    address: { host: '127.0.0.1', port: 1234 },
    baseUrlSuffix: '/v1',
    settings: { billing: 'local', maxConcurrency: 1 },
    recognise: { requests: [{ method: 'GET', path: '/api/v0/models', expect: [{ path: ['data'], eachHas: ['type', 'arch', 'max_context_length'], atLeastOne: true }] }] },
    read: {
      list: { path: '/api/v0/models', array: 'data', id: 'id', filter: { field: 'type', equals: 'llm' } },
      window: 'loaded_context_length',
      ceiling: 'max_context_length',
      tools: 'unknown',
    },
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    adapterLabel: 'the Anthropic API',
    adapter: 'anthropic',
    impliedByAdapter: 'anthropic',
    baseUrlSuffix: '',
    settings: {},
  },
  {
    kind: GENERIC_SERVER_KIND,
    label: 'OpenAI-compatible',
    adapterLabel: 'the OpenAI-compatible API',
    adapter: 'chat-completions',
    baseUrlSuffix: '/v1',
    settings: { billing: 'local', maxConcurrency: 1 },
    read: { list: { path: '/v1/models', array: 'data', id: 'id' } },
  },
];
