import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape } from '@momonga/protocol';
import type { MessageInputItem } from '@momonga/protocol';
import { buildContext, itemCapFor, measurePinned } from '@momonga/context';
import type { BuildContextInput } from '@momonga/context';
import { HOME, PROJECT, capabilitiesFor, fakeBlobs, fakeReader, sourcesWith } from './helpers.ts';
import { ESTIMATED, meterOf, piece, pieceCounter } from './meter-fixtures.ts';
import { TEST_FENCE } from '@momonga/testkit';

const WINDOW = 4096;
const sized = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: 1024 });

const inputWith = (extra: Partial<BuildContextInput>): BuildContextInput => ({
  capabilities: sized,
  fence: TEST_FENCE,
  model: 'm',
  sources: sourcesWith({ systemPrompt: 'system#1900', task: piece('task', 10) as MessageInputItem }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  ...extra,
});

describe.for([false, true])('the item cap measured from a carried pinned count (observed capacity %s)', (observed) => {
  it('is sized from the carried count and the ceiling of the mode, and in off mode equals the cap measured at admission after a report within the estimator bound', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), WINDOW, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
    const ports = { meter, blobs: fakeBlobs(), instructions: fakeReader({}) };
    const mode = observed ? { observedCapacity: true as const } : {};
    const admission = await measurePinned(inputWith(mode), ports);
    const first = await buildContext(inputWith(mode), ports);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens + errorBoundOfShape(ESTIMATED_ERROR_SHAPE, first.inputTokens) });

    const carried = await measurePinned(inputWith({ ...mode, pinnedTokens: first.pinnedTokens }), ports);

    expect(carried.pinnedTokens).toBe(admission.pinnedTokens);
    if (!observed) expect(carried.itemCap).toBe(admission.itemCap);
    expect(carried.itemCap).toBe(itemCapFor(sized, carried.ceiling - admission.pinnedTokens));
  });
});
