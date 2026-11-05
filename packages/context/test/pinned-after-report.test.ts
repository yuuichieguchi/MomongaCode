import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape } from '@momonga/protocol';
import { MIN_ROOM_TOKENS, budgetFor, buildContext, inputCeilingFor, pinnedFloorFor } from '@momonga/context';
import type { BuildContextInput, HistoryItem, TokenMeter } from '@momonga/context';
import { HOME, PROJECT, capabilitiesFor, fakeBlobs, fakeReader, sourcesWith } from './helpers.ts';
import { ESTIMATED, meterOf, piece, pieceCounter } from './meter-fixtures.ts';

const WINDOW = 4096;
const OUTPUT = 1024;
const TASK_TOKENS = 10;
const REPLY_TOKENS = 10;

const sized = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: OUTPUT });
const ceiling = inputCeilingFor(sized);
const inputBudget = budgetFor(sized, 0).I;
const systemTokens = pinnedFloorFor(sized);
const firstEstimate = systemTokens + TASK_TOKENS;
const reportAtDeclaredBound = firstEstimate + errorBoundOfShape(ESTIMATED_ERROR_SHAPE, firstEstimate);

const reply: HistoryItem = { seq: 1, item: { type: 'message', role: 'assistant', content: `reply#${REPLY_TOKENS}` } };

const inputWith = (history: HistoryItem[]): BuildContextInput => ({
  capabilities: sized,
  model: 'm',
  sources: sourcesWith({ systemPrompt: `system#${systemTokens}`, task: piece('task', TASK_TOKENS), history }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
});

const build = (meter: TokenMeter, history: HistoryItem[]) => buildContext(inputWith(history), { meter, blobs: fakeBlobs(), instructions: fakeReader({}) });

describe('the pinned part admitted at run start, after the server reports it within the estimator bound (LM Studio lms-3/4/5)', () => {
  it('is sized so that admission passes on the estimate, the report leaves room in the input budget, and the static ceiling would not', () => {
    expect(ceiling - firstEstimate).toBeGreaterThanOrEqual(MIN_ROOM_TOKENS);
    expect(reportAtDeclaredBound + MIN_ROOM_TOKENS).toBeLessThanOrEqual(inputBudget);
    expect(ceiling - reportAtDeclaredBound).toBeLessThan(MIN_ROOM_TOKENS);
  });

  it('builds the next step without a report as it built the first', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), WINDOW, { tokenCounting: 'estimated', maxOutputTokens: OUTPUT });
    const first = await build(meter, []);
    expect(first.inputTokens).toBe(firstEstimate);

    await expect(build(meter, [reply])).resolves.toMatchObject({ pinnedTokens: firstEstimate });
  });

  it('builds the next step after the first request is reported at the estimator bound, with the same pinned items', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), WINDOW, { tokenCounting: 'estimated', maxOutputTokens: OUTPUT });
    const first = await build(meter, []);
    expect(first.inputTokens).toBe(firstEstimate);
    const observed = meter.observe({ inputDigest: first.inputDigest, inputTokens: reportAtDeclaredBound });
    expect(observed.miss).toBe(0);

    await expect(build(meter, [reply])).resolves.toMatchObject({ pinnedDigest: first.pinnedDigest });
  });
});
