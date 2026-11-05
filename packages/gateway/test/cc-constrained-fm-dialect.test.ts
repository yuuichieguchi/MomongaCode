import { describe, expect, it } from 'vitest';
import { FM_VOCABULARY, runProbe } from '@momonga/gateway';
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

const twoToolRequest: AdapterRequest = {
  model: 'system',
  input: [userText('Read the file README.md')],
  tools: [readFileTool, listDirTool],
};

const constrainedRunOnFm = async (support: Record<ProbeKeyword, boolean>) => {
  const fake = await startFake({ scenario: 'tools-ok', wire: 'fm' });
  const adapter = makeAdapter(fake, { keywordSupport: () => support, schemaDialect: () => 'guided-generation' }, 'constrained');
  return collect(adapter, twoToolRequest);
};

describe('constrained tool calling against fm', () => {
  it('fm decodes the envelope built from the unprobed keyword support', async () => {
    const { events, error } = await constrainedRunOnFm(UNPROBED_FM_SUPPORT);

    expect(error).toBeUndefined();
    expect(terminalOf(events).type).toBe('response.completed');
  });

  it('fm decodes the envelope built from the keyword support the probe measures on fm', async () => {
    const probed = await startFake({ scenario: 'tools-ok', wire: 'fm', contextWindow: 4096, contextSizeExposure: 'none' });
    const report = await runProbe({
      socketPath: probed.socketPath,
      managedHealthRoute: true,
      samples: 2,
      vocabulary: FM_VOCABULARY,
      schemaDialect: 'guided-generation',
    });

    expect(report.keywordSupport.enum).toBe(true);
    expect(report.keywordSupport.anyOf).toBe(true);

    const { events, error } = await constrainedRunOnFm(report.keywordSupport);

    expect(error).toBeUndefined();
    expect(terminalOf(events).type).toBe('response.completed');
  });
});
