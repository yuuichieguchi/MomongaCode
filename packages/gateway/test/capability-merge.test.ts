import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { layerOf, mergeCapabilities } from '../src/probe/decide.ts';
import { OLLAMA_CAPABILITIES } from './ollama-support.ts';

const PROBED_AT = '2026-11-05T12:00:00.000Z';

const declared: Capabilities = { ...OLLAMA_CAPABILITIES, contextWindow: 8192, structuredOutput: 'none', parallelToolCalls: false, promptCache: { kind: 'none' } };

describe('one merge decides declared against probed capabilities', () => {
  it('keeps the declared window, output, image and prompt cache over the probe', () => {
    const merged = mergeCapabilities({
      defaults: layerOf(declared).core,
      declared: layerOf(declared).layer,
      probed: { contextWindow: 1024, maxOutputTokens: 64, promptCache: { kind: 'automatic' }, image: { imageInput: false } },
      probedAt: PROBED_AT,
    });
    expect(merged).toMatchObject({ contextWindow: 8192, maxOutputTokens: 2048, promptCache: { kind: 'none' }, imageInput: true, imageTokens: OLLAMA_CAPABILITIES.imageTokens });
  });

  it('takes the probed tool calling, structured output and parallel calls over the declaration', () => {
    const merged = mergeCapabilities({
      defaults: layerOf(declared).core,
      declared: layerOf(declared).layer,
      probed: { toolCalling: 'none', structuredOutput: 'json_schema', parallelToolCalls: true, reasoning: { control: 'none' } },
      probedAt: PROBED_AT,
    });
    expect(merged).toMatchObject({ toolCalling: 'none', structuredOutput: 'json_schema', parallelToolCalls: true, reasoning: { control: 'none' }, source: 'probed', probedAt: PROBED_AT });
  });

  it('keeps the declared value of a field the probe did not measure', () => {
    const merged = mergeCapabilities({ defaults: layerOf(declared).core, declared: layerOf(declared).layer, probed: {}, probedAt: PROBED_AT });
    expect(merged).toMatchObject({ structuredOutput: 'none', parallelToolCalls: false, toolCalling: 'native' });
  });

  it('gives the probed values to a target that declares nothing, over its defaults', () => {
    const merged = mergeCapabilities({
      defaults: layerOf(declared).core,
      declared: {},
      probed: { contextWindow: 1024, maxOutputTokens: 64, image: { imageInput: false } },
      probedAt: PROBED_AT,
    });
    expect(merged).toMatchObject({ contextWindow: 1024, maxOutputTokens: 64, imageInput: false });
    expect(merged.imageTokens).toBeUndefined();
  });
});
