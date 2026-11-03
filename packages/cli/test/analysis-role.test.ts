import { describe, expect, it } from 'vitest';
import * as contextCommand from '../src/commands/context.ts';

type Capabilities = { contextWindow: number; maxOutputTokens: number; structuredOutput: 'json_schema' | 'none' };

type AnalysisModelFor = (input: {
  roles: Partial<Record<'compaction' | 'reflection' | 'analysis' | 'classifier', string>>;
  alias: string;
  capabilitiesOf: (alias: string) => Promise<Capabilities>;
}) => Promise<{ alias: string; capabilities: Capabilities }>;

const CAPABILITIES: Record<string, Capabilities> = {
  opus: { contextWindow: 200_000, maxOutputTokens: 8192, structuredOutput: 'json_schema' },
  cheap: { contextWindow: 32_000, maxOutputTokens: 2048, structuredOutput: 'json_schema' },
  plain: { contextWindow: 32_000, maxOutputTokens: 2048, structuredOutput: 'none' },
};

const asked: string[] = [];

const capabilitiesOf = async (alias: string): Promise<Capabilities> => {
  asked.push(alias);
  const found = CAPABILITIES[alias];
  if (found === undefined) throw new Error(`unknown alias ${alias}`);
  return found;
};

const analysisModelFor = (): AnalysisModelFor => {
  const found = (contextCommand as Record<string, unknown>)['analysisModelFor'];
  if (typeof found !== 'function') throw new Error('commands/context.ts does not export analysisModelFor');
  return found as AnalysisModelFor;
};

describe('the analysis role of context improve', () => {
  it('guards a role that is ignored: the analysis and candidate calls go to the analysis alias with its capabilities', async () => {
    asked.length = 0;
    const chosen = await analysisModelFor()({ roles: { analysis: 'cheap' }, alias: 'opus', capabilitiesOf });
    expect(chosen).toEqual({ alias: 'cheap', capabilities: CAPABILITIES['cheap'] });
    expect(asked).toEqual(['cheap']);
  });

  it('guards a default that moves: with no analysis role the calls use the --alias of the command', async () => {
    const chosen = await analysisModelFor()({ roles: { compaction: 'cheap' }, alias: 'opus', capabilitiesOf });
    expect(chosen).toEqual({ alias: 'opus', capabilities: CAPABILITIES['opus'] });
  });

  it('guards a schema the role cannot hold: an analysis role without structured output is refused, naming the role, the alias and the capability', async () => {
    const failure = analysisModelFor()({ roles: { analysis: 'plain' }, alias: 'opus', capabilitiesOf });
    await expect(failure).rejects.toBeInstanceOf(contextCommand.ContextImproveError);
    await expect(failure).rejects.toThrow('models.roles.analysis');
    await expect(failure).rejects.toThrow('plain');
    await expect(failure).rejects.toThrow('structured output');
  });

  it('guards the existing fallback: without a role, an --alias without structured output is still used and answers in plain text', async () => {
    const chosen = await analysisModelFor()({ roles: {}, alias: 'plain', capabilitiesOf });
    expect(chosen).toEqual({ alias: 'plain', capabilities: CAPABILITIES['plain'] });
  });
});
