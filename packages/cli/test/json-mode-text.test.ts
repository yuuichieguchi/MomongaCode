import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { formatModels } from '../src/commands/models.ts';

const capabilities = {
  contextWindow: 4096,
  maxOutputTokens: 512,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 1,
  source: 'probed',
} as unknown as Capabilities;

const textFor = (jsonMode: unknown): string =>
  formatModels([{ id: 'one', targets: ['a'], capabilities: jsonMode === undefined ? capabilities : { ...capabilities, jsonMode } } as never]);

describe('/models shows the JSON-only mode', () => {
  it.each([
    ['json_object', 'JSON-only mode: json_object'],
    ['none', 'JSON-only mode: none'],
    [undefined, 'JSON-only mode: not measured'],
  ] as const)('shows %s as %j', (jsonMode, line) => {
    expect(textFor(jsonMode)).toContain(line);
  });
});
