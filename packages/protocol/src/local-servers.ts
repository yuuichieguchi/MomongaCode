export const LOCAL_SERVER_CANDIDATES: readonly string[] = ['http://127.0.0.1:11434', 'http://127.0.0.1:1234'];

export const LOCAL_SERVER_SHAPES = ['ollama', 'openai'] as const;
export type LocalServerShape = (typeof LOCAL_SERVER_SHAPES)[number];

export type LocalServerToolSupport = 'yes' | 'no' | 'unknown';

export type DetectedLocalServer = {
  baseUrl: string;
  shape: LocalServerShape;
  models: readonly { id: string; tools: LocalServerToolSupport }[];
};
