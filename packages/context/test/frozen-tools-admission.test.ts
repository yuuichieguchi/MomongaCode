import { describe, expect, it } from 'vitest';
import { PinnedOverflowError, budgetFor, measureLayers } from '@momonga/context';
import type { BuildContextInput } from '@momonga/context';
import type { MessageInputItem } from '@momonga/protocol';
import { HOME, PROJECT, capabilitiesFor, fakeBlobs, fakeReader, sourcesWith } from './helpers.ts';
import { EXACT, meterOf, piece, pieceCounter, toolOf } from './meter-fixtures.ts';

const WINDOW = 4096;
const capabilities = capabilitiesFor(WINDOW, { tokenCounting: 'exact', maxOutputTokens: 1024 });
const inputBudget = budgetFor(capabilities, 0).I;
const toolTokens = Math.ceil(inputBudget / 2) + 100;

const inputWith = (extra: Partial<BuildContextInput>): BuildContextInput => ({
  capabilities,
  model: 'm',
  sources: sourcesWith({ systemPrompt: 'system#100', task: piece('task', 10) as MessageInputItem, tools: [toolOf('A', toolTokens), toolOf('B', toolTokens)] }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  observedCapacity: true,
  ...extra,
});

const ports = () => ({ meter: meterOf(pieceCounter(EXACT), WINDOW, { tokenCounting: 'exact', maxOutputTokens: 1024 }), blobs: fakeBlobs(), instructions: fakeReader({}) });

describe('measuring the layers of an admitted build whose tool list is frozen', () => {
  it('is sized so that the frozen list alone is larger than the input budget', () => {
    expect(2 * toolTokens).toBeGreaterThan(inputBudget);
  });

  it('measures every frozen tool the build will send and refuses the pinned part they make', async () => {
    const frozen = { toolsFrozen: true } as Partial<BuildContextInput>;

    await expect(measureLayers(inputWith(frozen), ports())).rejects.toBeInstanceOf(PinnedOverflowError);
  });

  it('still selects tools by room when the list is not frozen', async () => {
    await expect(measureLayers(inputWith({}), ports())).resolves.toBeUndefined();
  });
});
