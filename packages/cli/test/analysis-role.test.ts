import { describe, expect, it } from 'vitest';
import * as contextCommand from '../src/commands/context.ts';

type Capabilities = { contextWindow: number; maxOutputTokens: number; structuredOutput: 'json_schema' | 'none' };

type AnalysisModelFor = (input: {
  roles: Partial<Record<'compaction' | 'reflection' | 'analysis', string>>;
  model: string;
  capabilitiesOf: (model: string) => Promise<Capabilities>;
}) => Promise<{ model: string; capabilities: Capabilities }>;

const CAPABILITIES: Record<string, Capabilities> = {
  opus: { contextWindow: 200_000, maxOutputTokens: 8192, structuredOutput: 'json_schema' },
  cheap: { contextWindow: 32_000, maxOutputTokens: 2048, structuredOutput: 'json_schema' },
  plain: { contextWindow: 32_000, maxOutputTokens: 2048, structuredOutput: 'none' },
};

const asked: string[] = [];

const capabilitiesOf = async (model: string): Promise<Capabilities> => {
  asked.push(model);
  const found = CAPABILITIES[model];
  if (found === undefined) throw new Error(`unknown model ${model}`);
  return found;
};

const analysisModelFor = (): AnalysisModelFor => {
  const found = (contextCommand as Record<string, unknown>)['analysisModelFor'];
  if (typeof found !== 'function') throw new Error('commands/context.ts does not export analysisModelFor');
  return found as AnalysisModelFor;
};

type ImproveInputFor = (input: {
  seed: number;
  model: 'fake' | 'real';
  analysis: { model: string; capabilities: Capabilities };
  datasetTokens: number;
  current: undefined;
}) => { analysisModel: string };

const improveInputFor = (): ImproveInputFor => {
  const found = (contextCommand as Record<string, unknown>)['improveInputFor'];
  if (typeof found !== 'function') throw new Error('commands/context.ts does not export improveInputFor');
  return found as ImproveInputFor;
};

describe('the analysis role of context improve', () => {
  it('guards a role that is ignored: the analysis and candidate calls go to the analysis model with its capabilities', async () => {
    asked.length = 0;
    const chosen = await analysisModelFor()({ roles: { analysis: 'cheap' }, model: 'opus', capabilitiesOf });
    expect(chosen).toEqual({ model: 'cheap', capabilities: CAPABILITIES['cheap'] });
    expect(asked).toEqual(['cheap']);
  });

  it('guards a default that moves: with no analysis role the calls use the --model of the command', async () => {
    const chosen = await analysisModelFor()({ roles: { compaction: 'cheap' }, model: 'opus', capabilitiesOf });
    expect(chosen).toEqual({ model: 'opus', capabilities: CAPABILITIES['opus'] });
  });

  it('guards a role refused for a capability it does not need: an analysis role without structured output is used like any other', async () => {
    const chosen = await analysisModelFor()({ roles: { analysis: 'plain' }, model: 'opus', capabilitiesOf });
    expect(chosen).toEqual({ model: 'plain', capabilities: CAPABILITIES['plain'] });
  });

  it('guards a report that names the wrong model: the improve input names the model of the analysis role the calls used, not the --model of the command', async () => {
    const analysis = await analysisModelFor()({ roles: { analysis: 'cheap' }, model: 'opus', capabilitiesOf });
    const input = improveInputFor()({ seed: 7, model: 'real', analysis, datasetTokens: 10, current: undefined });
    expect(input.analysisModel).toBe('cheap');
  });

  it('uses a --model without structured output when no role is set', async () => {
    const chosen = await analysisModelFor()({ roles: {}, model: 'plain', capabilitiesOf });
    expect(chosen).toEqual({ model: 'plain', capabilities: CAPABILITIES['plain'] });
  });
});
