import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from '../src/index.ts';
import { REMEDY_SURFACES, SURFACES, imageCapability } from '../src/index.ts';
import type { Capabilities, RemedySurface, Surface } from '../src/index.ts';

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

const MODEL = { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 };

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

describe('the one surface type and the capability override', () => {
  it('keys the remedy surface on the Surface type of the vocabulary', () => {
    expect(REMEDY_SURFACES).toEqual(SURFACES);
    expectTypeOf<RemedySurface>().toEqualTypeOf<Surface>();
  });

  it('exports no capability override: the protocol export list omits applyCapabilityOverride', () => {
    expect(Object.keys(protocol)).not.toContain('applyCapabilityOverride');
  });
});
