import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { MemoryView } from '@momonga/protocol';
import { buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, HistoryItem } from '@momonga/context';
import { HOME, MODEL, PROJECT, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

const sized = capabilitiesFor(8192, { tokenCounting: 'estimated', maxOutputTokens: 1024 });

const memoryOf = (text: string): MemoryView => ({
  id: 'mem-1',
  scope: 'user',
  origin: 'trusted',
  project: null,
  text,
  source: { kind: 'tool', sessionId: 's1', runId: 'run-1', step: 1, callId: 'm1', seq: 4 },
  createdAt: Date.UTC(2026, 10, 1),
  keptAt: Date.UTC(2026, 10, 2),
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'unbound',
});

const first: HistoryItem[] = [call(1, 'c1'), output(2, 'c1', 'a'.repeat(7000)), assistant(3, 'done')];
const second: HistoryItem[] = [...first, assistant(4, 'more')];

const inputWith = (history: HistoryItem[], memories: MemoryView[]): BuildContextInput => ({
  capabilities: sized,
  model: MODEL,
  sources: sourcesWith({ history, memories }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  keepRecentTurns: 1,
  observedCapacity: true,
  renderedFull: new Set(['c1']),
  fence: TEST_FENCE,
});

const secondBuildWith = async (extraReported: number, memories: MemoryView[]): Promise<string[]> => {
  const meter = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE, 'estimated'), model: MODEL, capabilities: sized, observedCapacity: true });
  const ports: BuildContextPorts = { meter, blobs: fakeBlobs(), instructions: fakeReader({}) };
  const built = await buildContext(inputWith(first, []), ports);
  meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens + extraReported });
  return (await buildContext(inputWith(second, memories), ports)).loadedMemoryIds;
};

describe('person item 8: the memory share is the memory block counted under the candidate decomposition', () => {
  const small = [memoryOf('m'.repeat(4000))];
  const large = [memoryOf('m'.repeat(5000))];

  it('admits a memory inside its share and refuses one beyond it when the first request was reported as estimated', async () => {
    expect(await secondBuildWith(0, small)).toEqual(['mem-1']);
    expect(await secondBuildWith(0, large)).toEqual([]);
  });

  it('refuses the same oversized memory when the first request was reported 400 tokens above the estimate, because its size does not depend on the base decomposition', async () => {
    expect(await secondBuildWith(400, small)).toEqual(['mem-1']);
    expect(await secondBuildWith(400, large)).toEqual([]);
  });
});
