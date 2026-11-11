import { describe, expect, it } from 'vitest';
import { vocabularyOf, runProbe } from '@momonga/gateway';
import type { AdapterRequest, ProbeKeyword } from '@momonga/protocol';
import { collect, listDirTool, makeAdapter, readFileTool, startFake, terminalOf, userText } from './cc-support.ts';
import { FM_SERVER } from '@momonga/protocol';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';
import { hostProbePorts } from './probe-ports-support.ts';

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

const constrainedRunOnFm = async (support: Record<ProbeKeyword, boolean>, dialect = 'explicit-keys') => {
  const fake = await startFake({ scenario: 'tools-ok', wire: 'fm' });
  const adapter = makeAdapter(fake, { keywordSupport: () => support, schemaDialect: () => dialect }, 'constrained');
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
      ports: hostProbePorts,
      socketPath: probed.socketPath,
      managed: FM_PROBE_ROUTES,
      samples: 2,
      vocabulary: vocabularyOf(FM_SERVER),
    });

    const { keywordSupport, schemaDialect } = report;
    if (keywordSupport === undefined) throw new Error('the probe measured no keyword support');
    if (schemaDialect.selected === null) throw new Error('the probe selected no dialect');
    expect(schemaDialect.selected).toBe('explicit-keys');
    expect(keywordSupport.enum).toBe(true);
    expect(keywordSupport.anyOf).toBe(true);

    const { events, error } = await constrainedRunOnFm(keywordSupport, schemaDialect.selected);

    expect(error).toBeUndefined();
    expect(terminalOf(events).type).toBe('response.completed');
  });
});
