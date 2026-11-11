import type { ProbeReport } from '@momonga/protocol';

export const makeReport = (nativeValidRate: number, constrainedValidRate: number): ProbeReport => ({
  probedAt: '2026-10-23T00:00:00.000Z',
  health: { ok: true },
  modelId: 'system',
  contextWindow: { value: 4096, method: 'reported' },
  streaming: { supported: true, doneSentinel: true, usageInStream: false },
  usageReported: true,
  nativeTools: { accepted: true, validRate: nativeValidRate, roundTripOk: true },
  constrained: { accepted: true, validRate: constrainedValidRate },
  keywordSupport: {
    enum: true,
    anyOf: true,
    const: true,
    pattern: false,
    minimum: true,
    nested: true,
    additionalProperties: true,
  },
  stopSequences: false,
  imageInputAccepted: false,
  guardrail: {},
  tokenCalibration: { ratio: 1.1, errorBound: 0.05 },
  schemaDialect: { selected: 'json-schema-2020-12', shape: 'union', tried: [{ id: 'json-schema-2020-12', result: 'accepted' }] },
});
