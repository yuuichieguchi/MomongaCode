import type { Transcript } from '@momonga/eval';

export type Answerer = { target: string; adapter: string; upstreamModel: string; answers: 'model' | 'script' | 'unknown' };

export const REAL_TARGET: Answerer = { target: 'opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' };

export const OTHER_REAL_TARGET: Answerer = { target: 'sonnet', adapter: 'anthropic', upstreamModel: 'claude-sonnet', answers: 'model' };

export const SCRIPTED_TARGET: Answerer = { target: 'scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' };

export const UNDECLARED_TARGET: Answerer = { target: 'local-llama', adapter: 'ollama', upstreamModel: 'llama3', answers: 'unknown' };

export const answeredBy = (transcript: Transcript, ...answerers: Answerer[]): Transcript => ({ ...transcript, answeredBy: answerers }) as Transcript;
