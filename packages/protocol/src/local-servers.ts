export const LOCAL_SERVER_CANDIDATES: readonly string[] = ['http://127.0.0.1:11434', 'http://127.0.0.1:1234'];

export type LocalServerToolSupport = 'yes' | 'no' | 'unknown';

export type DetectedModel = { id: string; tools: LocalServerToolSupport; contextWindow?: number; ceiling?: number };

export type DetectedLocalServer = {
  kind: string;
  provider: string;
  address: string;
  models: readonly DetectedModel[];
};

export type DetectedManagedServer = {
  shape: 'managed';
  id: string;
  provider: string;
  binary: string;
  refused?: { message: string; remedy?: string };
};

export type LocalServerDetection = DetectedLocalServer | DetectedManagedServer;
