import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { MemoryView } from '@momonga/protocol';
import { buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, HistoryItem } from '@momonga/context';
import { HOME, MODEL, PROJECT, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith } from './helpers.ts';

const sized = capabilitiesFor(8192, { tokenCounting: 'estimated', maxOutputTokens: 1024 });

const memoryOf = (text: string): MemoryView => ({
  id: 'mem-1',
  scope: 'user',
  origin: 'trusted',
  project: null,
  text,
  source: { kind: 'tool', sessionId: 's1', runId: 'run-1', step: 1, callId: 'm1', seq: 4 },
  createdAt: Date.UTC(2026, 10, 1),
  lastUsedAt: Date.UTC(2026, 10, 2),
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
});

const secondBuildWith = async (reportedRatio: number, memories: MemoryView[]): Promise<string[]> => {
  const meter = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE, 'estimated'), model: MODEL, capabilities: sized, observedCapacity: true });
  const ports: BuildContextPorts = { meter, blobs: fakeBlobs(), instructions: fakeReader({}) };
  const built = await buildContext(inputWith(first, []), ports);
  meter.observe({ inputDigest: built.inputDigest, inputTokens: Math.floor(built.inputTokens * reportedRatio) });
  return (await buildContext(inputWith(second, memories), ports)).loadedMemoryIds;
};

describe('person item 8: the memory share is the memory block counted under the candidate decomposition', () => {
  const memories = [memoryOf('m'.repeat(4000))];

  it('admits the memory when the first request was reported accurately', async () => {
    expect(await secondBuildWith(1, memories)).toEqual(['mem-1']);
  });

  it('admits the same memory when the first request was reported at twice its estimate, because its true size is unchanged', async () => {
    expect(await secondBuildWith(2, memories)).toEqual(['mem-1']);
  });
});
