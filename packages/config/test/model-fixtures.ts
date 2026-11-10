export const OLLAMA_ADDRESS = 'http://127.0.0.1:11434';
export const LMSTUDIO_ADDRESS = 'http://127.0.0.1:1234/v1';

export const S1_FILE = {
  models: {
    connections: [
      {
        adapter: 'ollama',
        baseUrl: OLLAMA_ADDRESS,
        models: [{ id: 'devstral-small-2:latest', capabilities: { contextWindow: 131072, maxOutputTokens: 32768 } }],
      },
    ],
  },
};

export const S1 = {
  models: {
    connections: [
      {
        adapter: 'ollama',
        baseUrl: OLLAMA_ADDRESS,
        models: [
          { id: 'devstral-small-2:latest', capabilities: { contextWindow: 131072, maxOutputTokens: 32768 } },
          { id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } },
        ],
      },
    ],
  },
};

const S2_OLLAMA = {
  adapter: 'ollama',
  baseUrl: OLLAMA_ADDRESS,
  models: [{ id: 'gemma-3-4b:latest', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }],
};

export const S2_LMSTUDIO = {
  adapter: 'chat-completions',
  provider: 'lmstudio',
  baseUrl: LMSTUDIO_ADDRESS,
  billing: 'local',
  maxConcurrency: 1,
  models: [{ id: 'gemma-3-4b', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }],
};

export const S2 = { models: { connections: [S2_OLLAMA, S2_LMSTUDIO] } };

export const S2H = {
  models: {
    connections: [
      S2_OLLAMA,
      {
        adapter: 'chat-completions',
        baseUrl: LMSTUDIO_ADDRESS,
        billing: 'local',
        maxConcurrency: 1,
        models: [{ id: 'gemma-3-4b', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }],
      },
    ],
  },
};

export const S3_PLAN = { adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'gpt-5.5' }] };

export const S3_KEY = {
  adapter: 'open-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  models: [{ id: 'gpt-5.5', capabilities: { contextWindow: 400000, maxOutputTokens: 128000 } }],
};

export const S3 = {
  models: {
    connections: [S3_PLAN, S3_KEY],
    start: 'chatgpt/gpt-5.5',
    fallback: ['openai/gpt-5.5'],
    billingChanges: [{ from: 'plan', to: 'metered' }],
  },
};

export const S4_SERVER = { command: '/opt/llama/bin/llama-server', args: ['--socket', '{socket}'], readyPath: '/health' };

export const S4 = {
  models: {
    servers: { 'llama-server': S4_SERVER },
    connections: [
      {
        adapter: 'managed',
        server: 'llama-server',
        models: [{ id: 'qwen3-coder-30b', capabilities: { contextWindow: 65536, maxOutputTokens: 16384 } }],
      },
    ],
  },
};

export const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 } as const;

export const chatConnection = (baseUrl: string, ids: readonly string[] = ['m'], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'chat-completions',
  baseUrl,
  ...extra,
  models: ids.map((id) => ({ id, capabilities: CAPABILITIES })),
});

export const ollamaConnection = (baseUrl: string, ids: readonly string[] = ['m'], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'ollama',
  baseUrl,
  ...extra,
  models: ids.map((id) => ({ id, capabilities: CAPABILITIES })),
});
