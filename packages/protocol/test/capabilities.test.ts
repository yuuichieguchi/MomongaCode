import { describe, expect, it } from 'vitest';
import { applyCapabilityOverride, imageCapability } from '../src/index.ts';
import type { Capabilities } from '../src/index.ts';

const BASE: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
};

const MODEL = { pixelsPerToken: 750, maxTokens: 1600 };

describe('imageCapability', () => {
  it('refuses image input without a token model', () => {
    expect(() => imageCapability(true, undefined)).toThrow(/imageTokens/);
  });

  it('refuses a token model without image input', () => {
    expect(() => imageCapability(false, MODEL)).toThrow(/imageInput is false/);
  });

  it('builds both valid shapes', () => {
    expect(imageCapability(true, MODEL)).toEqual({ imageInput: true, imageTokens: MODEL });
    expect(imageCapability(false, undefined)).toEqual({ imageInput: false });
  });
});

describe('applyCapabilityOverride', () => {
  it('refuses an override that enables images without a token model', () => {
    expect(() => applyCapabilityOverride(BASE, { imageInput: true })).toThrow(/imageTokens/);
  });

  it('keeps the declared model when only other fields are overridden', () => {
    const seeing = applyCapabilityOverride(BASE, { imageInput: true, imageTokens: MODEL });
    expect(applyCapabilityOverride(seeing, { contextWindow: 4096 })).toEqual({ ...seeing, contextWindow: 4096 });
  });

  it('drops the declared model when the override disables images', () => {
    const seeing = applyCapabilityOverride(BASE, { imageInput: true, imageTokens: MODEL });
    expect(applyCapabilityOverride(seeing, { imageInput: false })).toEqual({ ...BASE });
  });
});
