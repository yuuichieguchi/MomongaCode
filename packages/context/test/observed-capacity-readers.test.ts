import { describe, expect, it } from 'vitest';
import {
  MIN_ROOM_TOKENS,
  PinnedOverflowError,
  PinnedRoomError,
  buildContext,
  budgetFor,
  capacityFor,
  inputCeilingFor,
  itemCapFor,
  measureLayers,
  measurePinned,
} from '@momonga/context';
import type { ActivatedSkill, BuildContextInput } from '@momonga/context';
import type { Capabilities, FunctionTool, MessageInputItem } from '@momonga/protocol';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, capabilitiesFor, fakeBlobs, fakeReader, sourcesWith, user } from './helpers.ts';
import { weightMeter, weightOf } from './weight-meter.ts';
import type { UnderRule } from './weight-meter.ts';
import { TEST_FENCE } from '@momonga/testkit';

const WINDOW = 8192;
const OUTPUT = 1024;

const estimated = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: OUTPUT });
const exactAtWholeBudget = capabilitiesFor(WINDOW, { tokenCounting: 'exact', maxOutputTokens: OUTPUT });

const nothingUnder: UnderRule = () => 0;
const wholeUnder: UnderRule = (tokens) => tokens;

const systemWeight = weightOf({ type: 'message', role: 'system', content: SYSTEM_PROMPT });
const emptyTask: MessageInputItem = { type: 'message', role: 'user', content: '' };

const taskWeighing = (target: number): MessageInputItem => ({ type: 'message', role: 'user', content: 't'.repeat(target - systemWeight - weightOf(emptyTask)) });

const toolNamed = (index: number): FunctionTool => ({
  type: 'function',
  name: `Tool${String(index).padStart(2, '0')}`,
  description: 'd'.repeat(200),
  parameters: { type: 'object', properties: {} },
});

const TOOLS = Array.from({ length: 30 }, (_, index) => toolNamed(index));

type Setup = { task?: MessageInputItem; tools?: readonly FunctionTool[]; skills?: readonly ActivatedSkill[]; observed: boolean };

const inputWith = (capabilities: Capabilities, { task, tools, skills, observed }: Setup): BuildContextInput => {
  const input: BuildContextInput & { observedCapacity?: true } = {
    capabilities,
    fence: TEST_FENCE,
    model: MODEL,
    sources: sourcesWith({
      history: [user(1, 'question')],
      ...(task === undefined ? {} : { task }),
      ...(tools === undefined ? {} : { tools: [...tools] }),
      ...(skills === undefined ? {} : { activatedSkills: [...skills] }),
    }),
    evicted: new Set<string>(),
    recordedReferences: new Set<string>(),
    touchedPaths: [],
    trusted: true,
    projectRoot: PROJECT,
    home: HOME,
    keepRecentTurns: 1,
    ...(observed ? { observedCapacity: true as const } : {}),
  };
  return input;
};

const portsWith = (under: UnderRule) => ({ meter: weightMeter(under), blobs: fakeBlobs(), instructions: fakeReader() });

describe.for([
  ['nothing', nothingUnder],
  ['the whole count', wholeUnder],
] as const)('the claim-start measure reads C with context.observedCapacity, under = %s (4.7, readers of C)', ([, under]) => {
  it('reports C as the ceiling, C − pinned as the room, and the item cap of that room for the inline output limit', async () => {
    const capacity = capacityFor(estimated, under);
    expect(capacity).not.toBe(inputCeilingFor(estimated));

    const measured = await measurePinned(inputWith(estimated, { observed: true }), portsWith(under));

    expect(measured.ceiling).toBe(capacity);
    expect(measured.room).toBe(capacity - measured.pinnedTokens);
    expect(measured.itemCap).toBe(itemCapFor(estimated, capacity - measured.pinnedTokens));
  });
});

describe('the tool floor pinnedFloorFor reads C at claim start (4.7, readers of C; B7)', () => {
  it('keeps the tools a static ceiling equal to C would keep', async () => {
    const atStatic = await buildContext(inputWith(estimated, { tools: TOOLS, observed: false }), portsWith(nothingUnder));
    const atC = await buildContext(inputWith(exactAtWholeBudget, { tools: TOOLS, observed: false }), portsWith(nothingUnder));
    expect(atStatic.tools.length).toBeLessThan(atC.tools.length);

    const observed = await buildContext(inputWith(estimated, { tools: TOOLS, observed: true }), portsWith(nothingUnder));

    expect(observed.tools.map((tool) => tool.name)).toEqual(atC.tools.map((tool) => tool.name));
  });
});

describe('the pinned errors read C at admission (4.7, readers of C)', () => {
  it('names C as the ceiling of a PinnedOverflowError when C is below the static ceiling', async () => {
    const capacity = capacityFor(estimated, wholeUnder);
    const task = taskWeighing(Math.floor((capacity + inputCeilingFor(estimated)) / 2));

    const error = await measurePinned(inputWith(estimated, { task, observed: true }), portsWith(wholeUnder)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PinnedOverflowError);
    expect((error as PinnedOverflowError).ceiling).toBe(capacity);
  });

  it('admits a floor that leaves MIN_ROOM_TOKENS below C but not below the static ceiling', async () => {
    const task = taskWeighing(inputCeilingFor(estimated) - Math.floor(MIN_ROOM_TOKENS / 2));
    const atStatic = await measurePinned(inputWith(estimated, { task, observed: false }), portsWith(nothingUnder)).catch((caught: unknown) => caught);
    expect(atStatic).toBeInstanceOf(PinnedRoomError);

    const observed = await measurePinned(inputWith(estimated, { task, observed: true }), portsWith(nothingUnder));

    expect(observed.ceiling).toBe(budgetFor(estimated, 0).I);
  });
});

describe('a skill activation is admitted against C (4.7, readers of C; skill-admission.ts)', () => {
  it('admits a skill whose instructions fit C but not the static ceiling', async () => {
    const between = Math.floor((inputCeilingFor(estimated) + budgetFor(estimated, 0).I) / 2);
    const skills: ActivatedSkill[] = [{ name: 'big', content: 's'.repeat(between - systemWeight - weightOf(emptyTask)) }];
    const atStatic = await measureLayers(inputWith(estimated, { skills, observed: false }), portsWith(nothingUnder)).catch((caught: unknown) => caught);
    const atC = await measureLayers(inputWith(exactAtWholeBudget, { skills, observed: false }), portsWith(nothingUnder)).catch((caught: unknown) => caught);
    expect(atStatic).toBeInstanceOf(PinnedOverflowError);
    expect(atC).toBeUndefined();

    const observed = await measureLayers(inputWith(estimated, { skills, observed: true }), portsWith(nothingUnder)).catch((caught: unknown) => caught);

    expect(observed).toBeUndefined();
  });
});
