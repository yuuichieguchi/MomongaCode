import { describe, expect, it } from 'vitest';
import type { OllamaEndpointRecord } from '../src/probe/endpoint-record.ts';
import type { DeclaredCapabilities } from '../src/probe/decide.ts';
import { createProbedOllamaTarget } from '../src/probe/ollama-target.ts';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import { declarationOf, reportedFieldsOf, reportedWindowOf, unknownFieldsOf } from '../src/probe/sources.ts';
import { isTargetProbingError } from '../src/probe/auto-probe.ts';

const DECLARED: DeclaredCapabilities = {
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
};

const PROBING = { state: 'probing', message: 'measuring', retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare it' } } as const;

describe('the three sources of a capability: declared, reported by the server, measured', () => {
  it('takes the tool support and the window the server reports in its details', () => {
    expect(reportedFieldsOf({ window: 131_072, tools: 'yes', capabilities: ['completion', 'tools'] })).toEqual({
      toolCalling: 'native',
      contextWindow: 131_072,
      thinking: false,
      vision: false,
    });
    expect(reportedFieldsOf({ window: 8_192, tools: 'no', capabilities: ['completion'] })).toEqual({
      toolCalling: 'none',
      contextWindow: 8_192,
      thinking: false,
      vision: false,
    });
    expect(reportedFieldsOf({ tools: 'unknown' })).toEqual({});
    expect(reportedFieldsOf(undefined)).toEqual({});
  });

  it('carries the thinking and vision the server lists in its capabilities, and the absence of each as a refusal', () => {
    expect(reportedFieldsOf({ window: 131_072, tools: 'yes', capabilities: ['completion', 'tools', 'thinking', 'vision'] })).toEqual({
      toolCalling: 'native',
      contextWindow: 131_072,
      thinking: true,
      vision: true,
    });
    expect(reportedFieldsOf({ tools: 'no', capabilities: ['completion'] })).toEqual({ toolCalling: 'none', thinking: false, vision: false });
  });

  it('takes the window of a model from what the server lists, else from its details', () => {
    expect(reportedWindowOf({ id: 'qwen', tools: 'yes', ceiling: 40_960 })).toBe(40_960);
    expect(reportedWindowOf({ id: 'qwen', tools: 'unknown', contextWindow: 8_192, ceiling: 40_960 })).toBe(8_192);
    expect(reportedWindowOf({ id: 'qwen', tools: 'unknown' })).toBeUndefined();
  });

  it('leaves for measurement only a needed field that neither the declaration nor the server gives', () => {
    expect(unknownFieldsOf({ toolCalling: 'auto' }, {})).toEqual(['toolCalling']);
    expect(unknownFieldsOf({ toolCalling: 'auto' }, { toolCalling: 'native' })).toEqual([]);
    expect(unknownFieldsOf({ toolCalling: 'none' }, {})).toEqual([]);
  });

  it('names the declaration that makes the measurement unnecessary', () => {
    const text = declarationOf('ollama/qwen', ['toolCalling']);
    expect(text).toContain('toolCalling');
    expect(text).toContain('ollama/qwen');
  });

  it('serves an Ollama model whose tool support the server reports at once from the sources, and starts no measurement', async () => {
    let started = 0;
    const target = createProbedOllamaTarget({ written: DECLARED,
      targetName: 'ollama/qwen',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen',
      declared: DECLARED,
      toolCalling: 'auto',
      record: null,
      readRecord: async (): Promise<OllamaEndpointRecord | null> => null,
      readReported: async () => ({ toolCalling: 'native', contextWindow: 131_072 }),
      startProbe: async () => {
        started += 1;
        return PROBING;
      },
      readDigest: async () => 'sha256:1',
    });

    const capabilities = await target.capabilities();

    expect(started).toBe(0);
    expect(capabilities).toMatchObject({ toolCalling: 'native', contextWindow: DECLARED.contextWindow, source: 'reported' });
  });

  it('answers the measuring state at once for a chat-completions model whose tool support no source gives, naming the field', async () => {
    const asked: Array<readonly string[]> = [];
    const target = createProbedEndpointTarget({ written: DECLARED,
      targetName: 'lab/qwen',
      endpoint: 'http://127.0.0.1:1234/v1',
      model: 'qwen',
      declared: DECLARED,
      toolCalling: 'auto',
      record: null,
      readRecord: async () => null,
      readReported: async () => ({}),
      startProbe: async (unknown) => {
        asked.push(unknown.fields);
        return PROBING;
      },
      readIdentity: async () => 'id',
      saveRecord: async () => undefined,
    });

    const answer = await target.capabilities().catch((error: unknown) => error);

    expect(isTargetProbingError(answer)).toBe(true);
    expect(asked).toEqual([['toolCalling']]);
  });

  it('serves a chat-completions model whose needs are all declared, with no record and no measurement request', async () => {
    let started = 0;
    const target = createProbedEndpointTarget({ written: DECLARED,
      targetName: 'lab/qwen',
      endpoint: 'http://127.0.0.1:1234/v1',
      model: 'qwen',
      declared: DECLARED,
      toolCalling: 'native',
      record: null,
      readRecord: async () => null,
      readReported: async () => ({}),
      startProbe: async () => {
        started += 1;
        return PROBING;
      },
      readIdentity: async () => 'id',
      saveRecord: async () => undefined,
    });

    expect(await target.capabilities()).toMatchObject({ toolCalling: 'native', source: 'declared' });
    expect(started).toBe(0);
  });
});
