import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { layerOf, mergeCapabilities } from '../src/probe/decide.ts';
import { OLLAMA_CAPABILITIES } from './ollama-support.ts';

const PROBED_AT = '2026-11-05T12:00:00.000Z';

const declared: Capabilities = { ...OLLAMA_CAPABILITIES, outputBoundField: 'max_completion_tokens' };

describe('the capability merge carries the measured output bound field', () => {
  it('takes the probed field over the declared one, as a measured fact', () => {
    const merged = mergeCapabilities({ defaults: layerOf(declared).core, declared: layerOf(declared).layer, probed: { outputBoundField: 'max_tokens' }, probedAt: PROBED_AT });
    expect(merged.outputBoundField).toBe('max_tokens');
  });

  it('keeps the declared field when the probe measured none', () => {
    const merged = mergeCapabilities({ defaults: layerOf(declared).core, declared: layerOf(declared).layer, probed: {}, probedAt: PROBED_AT });
    expect(merged.outputBoundField).toBe('max_completion_tokens');
  });

  it('leaves the field unset when neither the declaration nor the probe names it', () => {
    const merged = mergeCapabilities({ defaults: layerOf(OLLAMA_CAPABILITIES).core, declared: {}, probed: {}, probedAt: PROBED_AT });
    expect(merged).not.toHaveProperty('outputBoundField');
  });
});
