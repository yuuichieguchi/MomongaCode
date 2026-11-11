import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { FunctionTool, InputItem } from '@momonga/protocol';
import { canonicalJson } from '@momonga/foundation';
import { buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, HistoryItem, TokenMeter } from '@momonga/context';
import { HOME, MODEL, PROJECT, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith, touchedFile } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

const sized = capabilitiesFor(8192, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const NESTED = '/proj/sub/AGENTS.md';

const toolNamed = (name: string, descriptionChars: number): FunctionTool => ({
  type: 'function',
  name,
  description: 'x'.repeat(descriptionChars),
  parameters: { type: 'object', properties: {} },
});

const first: HistoryItem[] = [call(1, 'c1'), output(2, 'c1', 'a'.repeat(7000)), assistant(3, 'done')];
const second: HistoryItem[] = [...first, assistant(4, 'more')];

const inputWith = (history: HistoryItem[], tools: FunctionTool[], touched: boolean): BuildContextInput => ({
  capabilities: sized,
  model: MODEL,
  sources: sourcesWith({ history, tools }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: touched ? [touchedFile('/proj/sub/x.ts')] : [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  keepRecentTurns: 1,
  observedCapacity: true,
  renderedFull: new Set(['c1']),
  fence: TEST_FENCE,
});

type Request = Parameters<TokenMeter['count']>[0];

const toolSelectionFrozen = async (touched: boolean): Promise<{ frozen: readonly InputItem[]; toolsDropped: boolean }> => {
  const tools = ['A', 'B'].map((name) => toolNamed(name, 2000));
  const inner = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE, 'estimated'), model: MODEL, capabilities: sized, observedCapacity: true });
  const requests: Request[] = [];
  const meter: TokenMeter = {
    ...inner,
    count: async (request) => {
      requests.push(request);
      return inner.count(request);
    },
  };
  const ports: BuildContextPorts = { meter, blobs: fakeBlobs(), instructions: fakeReader({ [NESTED]: 'n'.repeat(40000) }) };
  const built = await buildContext(inputWith(first, tools, false), ports);
  meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  requests.length = 0;
  const secondBuilt = await buildContext(inputWith(second, tools, touched), ports);
  const selecting = requests.find((request) => request.frozen !== undefined);
  if (selecting?.frozen === undefined) throw new Error('no frozen request');
  return { frozen: selecting.frozen, toolsDropped: secondBuilt.notices.some((notice) => notice.code === 'tools_dropped') };
};

describe('person item 8: tool selection is the first decision and reads only items already in F', () => {
  it('measures the tools against the same frozen items whether or not a nested AGENTS.md is a candidate that the build refuses', async () => {
    const withCandidate = await toolSelectionFrozen(true);
    const without = await toolSelectionFrozen(false);
    expect(withCandidate.frozen.map((item) => canonicalJson(item))).toEqual(without.frozen.map((item) => canonicalJson(item)));
    expect(withCandidate.toolsDropped).toBe(without.toolsDropped);
  });
});
