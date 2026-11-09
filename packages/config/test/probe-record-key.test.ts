import { describe, expect, it } from 'vitest';
import type { ResolvedModelTarget } from '../src/settings.ts';
import { probeRecordKeyOf } from '../src/probe-record-key.ts';

const capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: false,
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
  maxConcurrency: 4,
} as const;

const remote = { billing: 'metered', capabilities, maxConcurrency: 4, admissionTimeoutMs: 30000 } as const;

const configurations: ReadonlyArray<readonly [string, ResolvedModelTarget, ReturnType<typeof probeRecordKeyOf>]> = [
  ['chat-completions auto over tcp', { ...remote, adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1/', toolCalling: 'auto' }, { kind: 'endpoint', key: { endpoint: 'https://upstream.invalid/v1', model: 'm' } }],
  ['chat-completions auto over a socket', { ...remote, adapter: 'chat-completions', model: 'm', provider: 'p', socketPath: '/s/up.sock', toolCalling: 'auto' }, { kind: 'endpoint', key: { endpoint: 'unix:/s/up.sock', model: 'm' } }],
  ['chat-completions native', { ...remote, adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'native' }, undefined],
  ['chat-completions constrained', { ...remote, adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'constrained' }, undefined],
  ['open-responses', { ...remote, adapter: 'open-responses', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'native' }, undefined],
  ['anthropic', { ...remote, adapter: 'anthropic', model: 'm', baseUrl: 'https://upstream.invalid', toolCalling: 'native', apiVersion: '2026-10-21' }, undefined],
  ['ollama over tcp', { ...remote, adapter: 'ollama', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434' }, { kind: 'endpoint', key: { endpoint: 'http://127.0.0.1:11434', model: 'qwen3' } }],
  ['ollama over a socket', { ...remote, adapter: 'ollama', model: 'qwen3', socketPath: '/s/ollama.sock' }, { kind: 'endpoint', key: { endpoint: 'unix:/s/ollama.sock', model: 'qwen3' } }],
  ['ollama declaring a user dialect', { ...remote, capabilities: { ...capabilities, schemaDialect: 'ordered-subset' }, adapter: 'ollama', model: 'qwen3', socketPath: '/s/ollama.sock' }, { kind: 'endpoint', key: { endpoint: 'unix:/s/ollama.sock', model: 'qwen3' } }],
];

describe('the probe record the gateway reads for a target', () => {
  it.each(configurations)('%s', (_label, target, expected) => {
    expect(probeRecordKeyOf('x', target)).toEqual(expected);
  });
});
