export type View = { canon: string; provider: string; ownName: string; defaultTag?: string };

export const view = (provider: string, ownName: string, defaultTag?: string): View => ({
  canon: `${provider}/${ownName}`,
  provider,
  ownName,
  ...(defaultTag === undefined ? {} : { defaultTag }),
});

export const OLLAMA_TAG = 'latest';

export const S1: readonly View[] = [view('ollama', 'devstral-small-2:latest', OLLAMA_TAG), view('ollama', 'qwen3.8:27b', OLLAMA_TAG)];
export const S2: readonly View[] = [view('ollama', 'gemma-3-4b:latest', OLLAMA_TAG), view('lmstudio', 'gemma-3-4b')];
export const S2H: readonly View[] = [view('ollama', 'gemma-3-4b:latest', OLLAMA_TAG), view('srv-127.0.0.1-1234', 'gemma-3-4b')];
export const S3: readonly View[] = [view('chatgpt', 'gpt-5.5'), view('openai', 'gpt-5.5')];
export const SLASH_ID: readonly View[] = [view('lmstudio', 'google/gemma-3n-e4b')];
export const CANON_EQUAL: readonly View[] = [view('lmstudio', 'x'), view('srv-a-1', 'lmstudio/x')];
