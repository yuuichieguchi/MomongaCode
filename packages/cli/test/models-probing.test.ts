import { describe, expect, it } from 'vitest';
import { TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { MomongaModelEntry, MomongaModelList } from '@momonga/protocol';
import { formatModels, modelsDocumentOf } from '../src/commands/models.ts';

describe('the model list of a model the gateway is measuring', () => {
  it('shows the model without a window and no capability numbers, and names the state probing', () => {
    const measuring = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' } as const;
    const entry: MomongaModelEntry = {
      id: 'apple/system',
      object: 'model',
      provider: 'apple',
      ownName: 'system',
      billing: 'local',
      capabilities: measuring,
      state: 'available',
      chain: [{ model: 'apple/system', counter: '1'.repeat(64), billing: 'local', adapter: 'managed', answers: 'model', upstream: 'system', capabilities: measuring }],
    };
    const listing: MomongaModelList = { object: 'list', data: [entry], start: 'apple/system', roles: {} };

    const document = modelsDocumentOf(listing, new Map(), new Set());

    expect(formatModels(document)).toBe('apple\n  system  ·  window not known  ·  starts new sessions');
    expect(document.models[0]).toMatchObject({ state: 'probing', contextWindow: null });
  });
});
