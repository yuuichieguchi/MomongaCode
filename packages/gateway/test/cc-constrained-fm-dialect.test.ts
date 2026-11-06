import { describe, expect, it } from 'vitest';
import type { AdapterRequest, ProbeKeyword } from '@momonga/protocol';
import { collect, listDirTool, makeAdapter, readFileTool, startFake, terminalOf, userText } from './cc-support.ts';

const UNPROBED_FM_SUPPORT: Record<ProbeKeyword, boolean> = {
  enum: true,
  anyOf: true,
  const: true,
  pattern: true,
  minimum: true,
  nested: true,
  additionalProperties: true,
};

const SUPPORT_THE_PROBE_RECORDS_ON_REAL_FM: Record<ProbeKeyword, boolean> = {
  enum: false,
  anyOf: false,
  const: true,
  pattern: false,
  minimum: true,
  nested: true,
  additionalProperties: true,
};

const twoToolRequest: AdapterRequest = {
  model: 'system',
  input: [userText('Read the file README.md')],
  tools: [readFileTool, listDirTool],
};

const constrainedRunOnFm = async (support: Record<ProbeKeyword, boolean>) => {
  const fake = await startFake({ scenario: 'tools-ok', wire: 'fm' });
  const adapter = makeAdapter(fake, { keywordSupport: () => support }, 'constrained');
  return collect(adapter, twoToolRequest);
};

describe('constrained tool calling against fm', () => {
  it('fm decodes the envelope built from the unprobed keyword support', async () => {
    const { events, error } = await constrainedRunOnFm(UNPROBED_FM_SUPPORT);

    expect(error).toBeUndefined();
    expect(terminalOf(events).type).toBe('response.completed');
  });

  it('fm decodes the envelope built from the keyword support the probe records on fm', async () => {
    const { events, error } = await constrainedRunOnFm(SUPPORT_THE_PROBE_RECORDS_ON_REAL_FM);

    expect(error).toBeUndefined();
    expect(terminalOf(events).type).toBe('response.completed');
  });
});
