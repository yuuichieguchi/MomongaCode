import { canonicalJson } from '@momonga/foundation';
import {
  COMPACT_AT,
  EVICT_LOW_WATER,
  findDanglingOutput,
  findUnpairedCalls,
  floorRatio,
  largestSummaryCapFor,
  summaryItemTokensFor,
  summaryPromptTokensFor,
  summaryTokenCapFor,
} from '@momonga/protocol';
import type { Capabilities, FunctionCallOutputInputItem, FunctionTool, InputItem, MessageInputItem } from '@momonga/protocol';
import { MIN_ROOM_TOKENS, budgetFor, capacityFor, inputCeilingFor, itemCapFor, memoryBudgetFor, proactiveGainFor, summaryInputCeilingFor, pinnedFloorAt, withCalibration } from './budget.ts';
import { anatomyOf, historyLayerOf } from './anatomy.ts';
import type { TaggedItem } from './anatomy.ts';
import { chainTail, digestChain, frozenItem } from './digests.ts';
import { ContextOverflowError, PinnedBoundError, PinnedOverflowError, PinnedRoomError, PrefixChangedError } from './errors.ts';
import { governingMessageOf, governingNoticesOf, loadedGoverningOf } from './governing.ts';
import { discoverInstructions, recordedNestedFile } from './instructions.ts';
import type { DiscoveredInstructions, LoadedInstructionFile } from './instructions.ts';
import { DEFAULT_KEEP_RECENT_STEPS, DEFAULT_KEEP_RECENT_TURNS, protectionRungsOf, retainedHistoryOf, shapeOf } from './levels.ts';
import { textOfItem } from './item-text.ts';
import { renderMemories } from './memory.ts';
import { readerNamesOf, readersOffered } from './references.ts';
import { workingStateMessage } from './working-state.ts';
import { heldSkillOf, pointToHeldSkill } from './skill-output.ts';
import { identicalMarker, identicalReferents } from './formatters/identical.ts';
import { cutChars, fitToTokens, omittedMarker, outputRenderOf, outputTextOf, withOutput } from './tool-output.ts';
import type { OutputRender } from './tool-output.ts';
import type {
  BuildContextInput,
  BuildContextPorts,
  BuiltContext,
  CompactionBlock,
  CompactionPlan,
  ContextEviction,
  ContextNotice,
  ContextZones,
  ItemCountContext,
  MeterCount,
  PinnedBreakdown,
  PinnedMeasure,
  ProtectionLevel,
  TokenMeter,
} from './types.ts';

const BLOB_MEDIA_TYPE = 'text/plain';
const MANUAL_COMPACTION_GAIN = 1;

type OutputState = {
  original: FunctionCallOutputInputItem;
  render: OutputRender;
  callId: string;
  text: string;
  tokens: number;
  handle: string | undefined;
  persisted: boolean;
  reference: OutputReference | undefined;
  mode: 'full' | 'truncated' | 'omitted';
  renderedTokens: number;
  keptChars: number | undefined;
};

type OutputReference = { to: string; item: FunctionCallOutputInputItem; tokens: number };

type Slot = {
  seq: number;
  turn: number;
  step: number;
  item: InputItem;
  output?: OutputState;
};

type Head = {
  discovered: DiscoveredInstructions;
  tools: FunctionTool[];
  notices: ContextNotice[];
  systemMessage: MessageInputItem;
  task: InputItem;
  pinnedLayers: InputItem[];
  catalogMessages: MessageInputItem[];
  mandateMessages: MessageInputItem[];
  governing: MessageInputItem[];
  pinnedDigest: string;
  pinnedTokens: number;
  ceiling: number;
  room: number;
  frozen: InputItem[];
  layers: InputItem[];
  counted: MeterCount;
  arrivals: ArrivalEntry[];
  instructionFiles: LoadedInstructionFile[];
  memoryMessage: MessageInputItem | undefined;
  memoryCount: number;
};

type Evaluation = {
  layers: InputItem[];
  frozen: InputItem[];
  ports: BuildContextPorts;
  ceiling: number;
  counted: MeterCount;
  ceilingTokens: number;
  exceeds: boolean;
  leavesNoRoom: boolean;
};

export type MaxInputBounds = {
  ceiling: number;
  inputBudget: number;
  errorBoundAt(tokens: number): number;
};

export const maxInputFor = ({ ceiling, inputBudget, errorBoundAt }: MaxInputBounds): number | undefined => {
  const fitsWithItsBound = (tokens: number): boolean => tokens + errorBoundAt(tokens) <= inputBudget;
  if (ceiling < 0 || !fitsWithItsBound(0)) return undefined;
  let low = 0;
  let high = Math.floor(ceiling);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsWithItsBound(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
};

const groupedByTier = (names: readonly string[], tiers: readonly (string | undefined)[]): string[] => {
  const groups = new Map<string | undefined, string[]>();
  names.forEach((name, index) => groups.set(tiers[index], [...(groups.get(tiers[index]) ?? []), name]));
  return [...groups].map(([tier, members]) => (tier === undefined ? members.join(', ') : `${tier}: ${members.join(', ')}`));
};

type RankedCandidates = { tools: FunctionTool[]; rankOf: ReadonlyMap<string, number>; tierOf: ReadonlyMap<string, string> };

const rankedCandidatesOf = (input: BuildContextInput): RankedCandidates => {
  const rankOf = new Map<string, number>();
  const tierOf = new Map<string, string>();
  const takenBy = new Map<number, string>();
  const tools = (input.tools === 'none' ? [] : input.sources.tools).map((candidate) => {
    const { fitRank, fitTier, ...definition } = candidate as FunctionTool & { fitRank?: unknown; fitTier?: unknown };
    const { name } = definition;
    const rank = fitRank;
    if (typeof rank !== 'number' || !Number.isInteger(rank)) throw new Error(`tool ${JSON.stringify(name)} has no fitRank`);
    const holder = takenBy.get(rank);
    if (holder !== undefined) throw new Error(`tools ${JSON.stringify(holder)} and ${JSON.stringify(name)} have the same fitRank ${rank}`);
    takenBy.set(rank, name);
    rankOf.set(name, rank);
    if (typeof fitTier === 'string') tierOf.set(name, fitTier);
    return definition;
  });
  return { tools, rankOf, tierOf };
};

const requiredToolsOf = (input: BuildContextInput, candidates: readonly FunctionTool[]): FunctionTool[] => {
  const names = new Set(readerNamesOf(input.sources.readers, input));
  return candidates.filter((tool) => names.has(tool.name));
};

const metering = (input: BuildContextInput, ports: BuildContextPorts, tools: readonly FunctionTool[]) => {
  const { capabilities } = input;
  const budgetOf = (counted: MeterCount) => budgetFor(capabilities, counted.underAt(counted.inputTokens));
  const fits = (counted: MeterCount): boolean => counted.inputTokens <= budgetOf(counted).I;
  const countInput = (items: readonly InputItem[], sent?: true): Promise<MeterCount> =>
    ports.meter.count({ input: items, tools, ...(sent === undefined ? {} : { sent }) });
  return { tools: [...tools], budgetOf, fits, countInput };
};

const frozenPorts = (ports: BuildContextPorts, frozen: readonly InputItem[]): BuildContextPorts => ({
  ...ports,
  meter: { ...ports.meter, count: (request) => ports.meter.count({ ...request, frozen: request.frozen ?? frozen }) },
});

const breakdownOf = async (
  ports: BuildContextPorts,
  systemMessage: MessageInputItem,
  layerItems: readonly InputItem[],
  governing: readonly InputItem[],
  task: InputItem,
  tools: readonly FunctionTool[],
): Promise<PinnedBreakdown> => {
  const countOf = async (items: readonly InputItem[], withTools: readonly FunctionTool[]): Promise<number> =>
    items.length === 0 && withTools.length === 0 ? 0 : (await ports.meter.count({ input: items, tools: withTools })).inputTokens;
  return {
    systemPrompt: await countOf([systemMessage], []),
    tools: await countOf([], tools),
    instructions: await countOf(
      layerItems.filter((item) => item !== systemMessage && !governing.includes(item)),
      [],
    ),
    governing: await countOf(governing, []),
    task: await countOf([task], []),
  };
};

const capacityOver = async (
  sized: Capabilities,
  ports: BuildContextPorts,
  frozen: readonly InputItem[],
  offered: readonly FunctionTool[],
): Promise<number> => {
  let smallest = Number.POSITIVE_INFINITY;
  for (const meter of [ports.meter, ...(ports.fallbackMeters ?? [])]) {
    const counted = await meter.count({ input: frozen, tools: offered, frozen });
    smallest = Math.min(smallest, capacityFor(sized, counted.underAt));
  }
  return smallest;
};

const admittedFloor = (input: BuildContextInput): boolean => input.pinnedTokens !== undefined;

const ceilingTokensOf = (input: BuildContextInput, counted: MeterCount): number =>
  input.observedCapacity === true ? counted.inputTokens : counted.freshInputTokens;

const measureHead = async (input: BuildContextInput, suppliedPorts: BuildContextPorts): Promise<Head> => {
  const { capabilities, sources } = input;
  const { tools: candidates, rankOf, tierOf } = rankedCandidatesOf(input);
  const discovered = await discoverInstructions({
    reader: suppliedPorts.instructions,
    home: input.home,
    projectRoot: input.projectRoot,
    trusted: input.trusted,
    touchedPaths: input.touchedPaths,
  });
  const systemMessage: MessageInputItem = { type: 'message', role: 'system', content: sources.systemPrompt };
  const task = frozenItem(sources.task);
  const catalogMessages: MessageInputItem[] =
    sources.skillCatalog === undefined ? [] : [{ type: 'message', role: 'developer', content: sources.skillCatalog }];
  const instructionMessages = [...catalogMessages, ...[discovered.user, discovered.root].flatMap((file) => (file === undefined ? [] : [file.message]))];
  const mandateMessages: MessageInputItem[] = sources.mandate === undefined ? [] : [{ type: 'message', role: 'developer', content: sources.mandate }];
  const pinnedLayers: InputItem[] = [systemMessage, ...instructionMessages, ...mandateMessages];
  const pinned: InputItem[] = [...pinnedLayers, task];
  const pinnedDigest = chainTail(digestChain({ scope: 'pinned-items' }, pinned));
  if (input.expectedPinnedDigest !== undefined && input.expectedPinnedDigest !== pinnedDigest) {
    throw new PrefixChangedError(input.expectedPinnedDigest, pinnedDigest);
  }
  const governing = governingMessageOf(sources.governing);
  const sized = input.calibration === undefined ? capabilities : withCalibration(capabilities, input.calibration);
  const observed = input.observedCapacity === true;
  const tail = await frozenTailOf(input, suppliedPorts, task);
  const appendOnly = input.layout === 'cachePrefix';
  const recordedMemory = pinnedMemoryMessageOf(input);
  let arrivals: ArrivalEntry[] = candidateArrivalsOf(input, discovered);
  const layersFor = (entries: readonly ArrivalEntry[], memory: MessageInputItem | undefined): InputItem[] =>
    layerItemsOf(appendOnly, pinnedLayers, governing, memory, entries);
  const baseKeys = new Set(arrivals.map((entry) => entry.key));
  const admittedArrivals = appendOnly ? arrivals : arrivals.filter((entry) => entry.layer === 'skills');
  const toolFrozen = [...layersFor(admittedArrivals, recordedMemory), ...tail];
  const toolPorts = frozenPorts(suppliedPorts, toolFrozen);
  const countWith = (offered: readonly FunctionTool[], over: BuildContextPorts): Promise<MeterCount> =>
    over.meter.count({ input: [...pinnedLayers, ...governing, task], tools: offered });
  const fitsFloor = (counted: MeterCount): boolean =>
    metering(input, toolPorts, candidates).fits(counted) && ceilingTokensOf(input, counted) <= toolFloor;
  const stableFitsFloor = async (offered: readonly FunctionTool[]): Promise<boolean> =>
    fitsFloor(await toolPorts.meter.count({ input: [...pinnedLayers, ...governing], tools: offered }));
  const hostOf = input.companions === undefined || input.companions.keepWithoutHost ? {} : input.companions.hostOf;
  const standsWith = (tool: FunctionTool, offered: readonly FunctionTool[]): boolean => {
    const host = hostOf[tool.name];
    return host === undefined || offered.some((other) => other.name === host);
  };
  const selectsTools = input.pinnedTokens === undefined && input.toolsFrozen !== true;
  for (const tool of candidates) {
    const host = hostOf[tool.name];
    const hostRank = host === undefined ? undefined : rankOf.get(host);
    if (hostRank !== undefined && hostRank >= rankOf.get(tool.name)!) {
      throw new Error(`tool ${JSON.stringify(tool.name)} has a fitRank that does not come after the fitRank of its host ${JSON.stringify(host)}`);
    }
  }
  const eligible = candidates.filter((tool) => standsWith(tool, candidates));
  const inFitOrder = [...eligible].sort((left, right) => rankOf.get(left.name)! - rankOf.get(right.name)!);
  const toolFloor =
    !selectsTools ? 0 : pinnedFloorAt(observed ? await capacityOver(sized, toolPorts, toolFrozen, eligible) : inputCeilingFor(sized));
  let tools = eligible;
  let leftOut: string[] = [];
  if (selectsTools && !(await stableFitsFloor(eligible))) {
    const required = requiredToolsOf(input, eligible);
    const kept: FunctionTool[] = [...required];
    const droppedForRoom: string[] = [];
    const droppedTiers: (string | undefined)[] = [];
    let stopped = false;
    for (const tool of inFitOrder) {
      if (required.includes(tool)) continue;
      if (!standsWith(tool, kept)) {
        droppedForRoom.push(`${tool.name} (with ${hostOf[tool.name]})`);
        droppedTiers.push(tierOf.get(tool.name));
      } else if (!stopped && (await stableFitsFloor([...kept, tool]))) kept.push(tool);
      else {
        stopped = true;
        droppedForRoom.push(tool.name);
        droppedTiers.push(tierOf.get(tool.name));
      }
    }
    if (kept.length > 0 || (await stableFitsFloor(kept))) {
      tools = eligible.filter((tool) => kept.includes(tool));
      leftOut = groupedByTier(droppedForRoom, droppedTiers);
    }
  }
  const { fits } = metering(input, toolPorts, tools);
  const notices: ContextNotice[] = [...discovered.notices, ...governingNoticesOf(sources.governing)];
  if (leftOut.length > 0) {
    notices.push({
      code: 'tools_dropped',
      message: `Tools ${leftOut.join('; ')} were left out because the declared context window of ${input.model} (${capabilities.contextWindow} tokens) leaves no room for them; raise the declared context window of that model, or shorten the instructions`,
      key: canonicalJson({ contextWindow: capabilities.contextWindow, model: input.model }),
    });
  }
  const evaluate = async (layerItems: InputItem[]): Promise<Evaluation> => {
    const frozen = [...layerItems, ...tail];
    const evaluationPorts = frozenPorts(suppliedPorts, frozen);
    const ceiling = observed ? await capacityOver(sized, evaluationPorts, frozen, tools) : inputCeilingFor(sized);
    const counted = await evaluationPorts.meter.count({ input: [...layerItems, task], tools });
    const ceilingTokens = ceilingTokensOf(input, counted);
    return {
      layers: layerItems,
      frozen,
      ports: evaluationPorts,
      ceiling,
      counted,
      ceilingTokens,
      exceeds: !fits(counted) || ceilingTokens > ceiling,
      leavesNoRoom: ceiling - ceilingTokens < MIN_ROOM_TOKENS,
    };
  };
  const refused = (path: string): void => {
    notices.push({ code: 'instructions_dropped', message: `${path} was dropped because the context budget was exceeded` });
  };
  let current = await evaluate(layersFor(arrivals, recordedMemory));
  if (appendOnly) {
    for (const file of discovered.nested) {
      if (baseKeys.has(`instructions:${file.instruction.path}`)) continue;
      const candidate = [...arrivals, instructionArrivalOf(file)];
      const next = await evaluate(layersFor(candidate, recordedMemory));
      if (next.exceeds || next.leavesNoRoom) {
        refused(file.instruction.path);
      } else {
        arrivals = candidate;
        current = next;
      }
    }
  } else {
    while ((current.exceeds || current.leavesNoRoom) && arrivals.some((entry) => entry.layer === 'instructions')) {
      const index = arrivals.findIndex((entry) => entry.layer === 'instructions');
      const [dropped] = arrivals.splice(index, 1);
      if (dropped?.file === undefined) break;
      refused(dropped.file.instruction.path);
      current = await evaluate(layersFor(arrivals, recordedMemory));
    }
  }
  const rankedMemories = sources.memories ?? [];
  const memoryCandidates =
    input.pinnedMemoryIds === undefined
      ? rankedMemories
      : input.pinnedMemoryIds.flatMap((id) => rankedMemories.filter((memory) => memory.id === id));
  let memoryMessage = recordedMemory;
  let memoryCount = 0;
  const moreMemories = sources.moreMemories === true;
  const memoriesDropped = (kept: number, total: number): void => {
    if (kept < total) {
      notices.push({
        code: 'memories_dropped',
        message: `${moreMemories ? 'at least ' : ''}${total - kept} of ${total} saved memories were left out of the context because of its budget`,
      });
    } else if (moreMemories) {
      notices.push({ code: 'memories_dropped', message: 'more saved memories exist than were read for the context, so some were left out because of its budget' });
    }
  };
  const omittedOf = (kept: number, total: number): number => Math.max(moreMemories ? 1 : 0, total - kept);
  const renderingOptions = { atLeast: moreMemories, matchCap: sources.memoryMatchCap };
  if (input.pinnedMemoryIds !== undefined && rankedMemories.length > 0) {
    memoryCount = memoryCandidates.length;
    memoriesDropped(memoryCount, rankedMemories.length);
  } else if (memoryCandidates.length > 0) {
    const withMemories = async (count: number): Promise<{ message: MessageInputItem; evaluation: Evaluation; fitsBudget: boolean }> => {
      const message: MessageInputItem = {
        type: 'message',
        role: 'user',
        content: renderMemories(memoryCandidates.slice(0, count), omittedOf(count, memoryCandidates.length), renderingOptions),
      };
      const evaluation = await evaluate(layersFor(arrivals, message));
      const baseTokens = ceilingTokensOf(input, await evaluation.ports.meter.count({ input: [...layersFor(arrivals, undefined), task], tools }));
      const fitsBudget =
        !evaluation.exceeds &&
        !evaluation.leavesNoRoom &&
        evaluation.ceilingTokens - baseTokens <= memoryBudgetFor(evaluation.ceiling - baseTokens, input.memoryShare);
      return { message, evaluation, fitsBudget };
    };
    if ((await withMemories(0)).fitsBudget) {
      let low = 0;
      let high = memoryCandidates.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((await withMemories(middle)).fitsBudget) low = middle;
        else high = middle - 1;
      }
      memoryCount = low;
      const chosen = await withMemories(memoryCount);
      memoryMessage = chosen.message;
      current = chosen.evaluation;
    }
    memoriesDropped(memoryCount, memoryCandidates.length);
  }
  const { layers, frozen, ceiling, counted, ceilingTokens, ports } = current;
  const pinnedCounted = input.pinnedTokens === undefined ? await countWith(tools, ports) : undefined;
  const pinnedTokens = input.pinnedTokens ?? ceilingTokensOf(input, pinnedCounted as MeterCount);
  const admitted = admittedFloor(input);
  if (!admitted && (pinnedTokens > ceiling || (pinnedCounted !== undefined && !fits(pinnedCounted)))) {
    throw new PinnedOverflowError({ pinnedTokens, ceiling, breakdown: await breakdownOf(ports, systemMessage, instructionMessages, governing, task, tools) });
  }
  const room = ceiling - pinnedTokens;
  if (!admitted && room < MIN_ROOM_TOKENS) {
    throw new PinnedRoomError({
      pinnedTokens,
      ceiling,
      room,
      minimum: MIN_ROOM_TOKENS,
      breakdown: await breakdownOf(ports, systemMessage, instructionMessages, governing, task, tools),
    });
  }
  if (!admitted && current.exceeds) {
    throw new PinnedOverflowError({
      pinnedTokens: ceilingTokens,
      ceiling,
      breakdown: await breakdownOf(ports, systemMessage, layers, governing, task, tools),
    });
  }
  if (!admitted && current.leavesNoRoom) {
    throw new PinnedRoomError({
      pinnedTokens: ceilingTokens,
      ceiling,
      room: ceiling - ceilingTokens,
      minimum: MIN_ROOM_TOKENS,
      breakdown: await breakdownOf(ports, systemMessage, layers, governing, task, tools),
    });
  }
  return {
    discovered,
    notices,
    tools,
    systemMessage,
    task,
    pinnedLayers,
    catalogMessages,
    mandateMessages,
    governing,
    pinnedDigest,
    pinnedTokens,
    ceiling,
    room,
    frozen,
    layers,
    counted,
    arrivals,
    instructionFiles: arrivals.flatMap((entry) => (entry.file === undefined ? [] : [entry.file])),
    memoryMessage,
    memoryCount,
  };
};

type ArrivalEntry = { key: string; message: MessageInputItem; layer: 'skills' | 'instructions'; file: LoadedInstructionFile | undefined };

const skillArrivalOf = (name: string, content: string): ArrivalEntry => ({
  key: `skill:${name}`,
  message: { type: 'message', role: 'developer', content: `Activated skill ${name}:\n${content}` },
  layer: 'skills',
  file: undefined,
});

const instructionArrivalOf = (file: LoadedInstructionFile): ArrivalEntry => ({
  key: `instructions:${file.instruction.path}`,
  message: file.message,
  layer: 'instructions',
  file,
});

const journalArrivalsOf = (input: BuildContextInput, discovered: DiscoveredInstructions): ArrivalEntry[] => {
  const pinnedPaths = new Set(discovered.pinnedPaths);
  return (input.arrivals ?? []).flatMap((arrival) => {
    if (arrival.kind === 'skill') return [skillArrivalOf(arrival.name, arrival.content)];
    if (pinnedPaths.has(arrival.path)) return [];
    const live = discovered.nested.find((file) => file.instruction.path === arrival.path);
    return [instructionArrivalOf(live ?? recordedNestedFile(discovered.platform, arrival.path, arrival.content))];
  });
};

const candidateArrivalsOf = (input: BuildContextInput, discovered: DiscoveredInstructions): ArrivalEntry[] =>
  input.layout === 'cachePrefix'
    ? journalArrivalsOf(input, discovered)
    : [
        ...discovered.nested.map(instructionArrivalOf),
        ...input.sources.activatedSkills.map((skill) => skillArrivalOf(skill.name, skill.content)),
      ];

const layerItemsOf = (
  appendOnly: boolean,
  pinnedLayers: readonly InputItem[],
  governing: readonly InputItem[],
  memory: MessageInputItem | undefined,
  arrivals: readonly ArrivalEntry[],
): InputItem[] =>
  appendOnly
    ? [...pinnedLayers, ...(memory === undefined ? [] : [memory]), ...arrivals.map((entry) => entry.message), ...governing]
    : [...pinnedLayers, ...governing, ...(memory === undefined ? [] : [memory]), ...arrivals.map((entry) => entry.message)];

const pinnedMemoryMessageOf = (input: BuildContextInput): MessageInputItem | undefined => {
  const ranked = input.sources.memories ?? [];
  if (input.pinnedMemoryIds === undefined || ranked.length === 0) return undefined;
  const chosen = input.pinnedMemoryIds.flatMap((id) => ranked.filter((memory) => memory.id === id));
  const more = input.sources.moreMemories === true;
  return {
    type: 'message',
    role: 'user',
    content: renderMemories(chosen, Math.max(more ? 1 : 0, ranked.length - chosen.length), { atLeast: more, matchCap: input.sources.memoryMatchCap }),
  };
};

const historyItemsOf = (sources: BuildContextInput['sources']) =>
  retainedHistoryOf(sources.history, sources.summary).map((entry) => {
    const item = frozenItem(entry.item);
    const held = heldSkillOf(item, sources.activatedSkills) !== undefined;
    return {
      seq: entry.seq,
      item: pointToHeldSkill(item, sources.activatedSkills),
      pointer: held,
      ...(entry.handle === undefined || held ? {} : { handle: entry.handle }),
      ...(entry.omittedTokens === undefined ? {} : { omittedTokens: entry.omittedTokens }),
    };
  });

type FrozenSlot = { item: InputItem; output?: { callId: string; text: string; full: boolean; original: FunctionCallOutputInputItem } };

const harnessToolsOf = (input: BuildContextInput): ReadonlySet<string> => new Set(input.harnessOutputTools ?? []);

const frozenTailOf = async (input: BuildContextInput, ports: BuildContextPorts, task: InputItem): Promise<InputItem[]> => {
  const { sources, evicted, forms, renderedFull } = input;
  const reader = sources.readers['output_handle'];
  const entries = historyItemsOf(sources);
  const callNames = new Map<string, string>();
  const harnessTools = harnessToolsOf(input);
  for (const entry of entries) if (entry.item.type === 'function_call') callNames.set(entry.item.call_id, entry.item.name);
  const countContextFor = (callId: string): ItemCountContext => {
    const name = callNames.get(callId);
    return { callNames: name === undefined ? {} : { [callId]: name }, withTools: input.tools !== 'none' };
  };
  const slots: FrozenSlot[] = [];
  let complete = true;
  for (const entry of entries) {
    const original = entry.item;
    if (original.type !== 'function_call_output') {
      slots.push({ item: original });
      continue;
    }
    const callId = original.call_id;
    const text = outputTextOf(original.output);
    const handle = 'handle' in entry ? entry.handle : ports.blobs.handleFor(text);
    const kept = forms?.get(callId);
    const render = outputRenderOf(original, callNames.get(callId), harnessTools, entry.pointer, input.fence);
    if (evicted.has(callId)) {
      const tokens = entry.omittedTokens ?? (await ports.meter.countItem(render.full, countContextFor(callId)));
      slots.push({ item: withOutput(original, omittedMarker(tokens, handle, reader)), output: { callId, text, full: false, original } });
    } else if (kept !== undefined) {
      const tokens = await ports.meter.countItem(render.full, countContextFor(callId));
      slots.push({ item: withOutput(original, render.enclose(cutChars(text, kept, handle, tokens, reader))), output: { callId, text, full: false, original } });
    } else if (renderedFull?.has(callId) === true) {
      slots.push({ item: render.full, output: { callId, text, full: true, original } });
    } else {
      complete = false;
      break;
    }
  }
  if (input.outputFormatters?.includes('identicalOutput') === true) {
    const outputs = slots.flatMap((slot, index) => (slot.output === undefined ? [] : [{ index, ...slot.output }]));
    const referents = identicalReferents(outputs.map(({ callId, text, full }) => ({ callId, text, full })));
    for (const { index, callId, text, original } of outputs) {
      const referent = referents.get(callId);
      if (referent !== undefined) (slots[index] as FrozenSlot).item = withOutput(original, identicalMarker(referent, ports.blobs.handleFor(text), reader));
    }
  }
  const items = slots.map((slot) => slot.item);
  const taskAt = entries.findIndex((entry) => entry.seq > sources.taskSeq);
  const ordered =
    taskAt < 0 ? (complete ? [...items, task] : items) : taskAt <= items.length ? [...items.slice(0, taskAt), task, ...items.slice(taskAt)] : items;
  const summaryItems: InputItem[] = sources.summary === undefined ? [] : [frozenItem(sources.summary.item)];
  return [...summaryItems, ...ordered];
};

export const measureLayers = async (input: BuildContextInput, ports: BuildContextPorts): Promise<void> => {
  await measureHead(input, ports);
};

export const measurePinned = async (input: BuildContextInput, ports: BuildContextPorts): Promise<PinnedMeasure> => {
  const { pinnedTokens, ceiling, room } = await measureHead(input, ports);
  return {
    pinnedTokens,
    ceiling,
    room,
    itemCap: itemCapFor(input.capabilities, room),
    summaryCap: summaryTokenCapFor(input.capabilities, room),
  };
};

export type EvictionPass = { kind: 'batch' } | { kind: 'toLowMark'; lowMark: number };

export const evictionPassFor = (layout: BuildContextInput['layout'], marks: { floorTokens: number; highMark: number }): EvictionPass =>
  layout === 'cachePrefix' ? { kind: 'batch' } : { kind: 'toLowMark', lowMark: marks.floorTokens + floorRatio(EVICT_LOW_WATER, marks.highMark - marks.floorTokens) };

export const buildContext = async (input: BuildContextInput, suppliedPorts: BuildContextPorts): Promise<BuiltContext> => {
  let ports = suppliedPorts;
  const { capabilities, sources, evicted } = input;
  const { blobs } = ports;
  const counts: MeterCount[] = [];
  const suppliedMeter = suppliedPorts.meter;
  const meter: TokenMeter = {
    ...suppliedMeter,
    count: async (request) => {
      const counted = await suppliedMeter.count(request);
      counts.push(counted);
      return counted;
    },
    countItem: (item, context) => suppliedMeter.countItem(item, context),
  };
  ports = { ...ports, meter };
  const trailing = [...(input.trailing ?? [])];
  const requestedKeepTurns = DEFAULT_KEEP_RECENT_TURNS;
  const requestedKeepSteps = DEFAULT_KEEP_RECENT_STEPS;
  const requestedLevel = input.level ?? 0;
  if (!Number.isInteger(requestedLevel) || requestedLevel < 0) throw new RangeError(`level must be a non-negative integer, received ${requestedLevel}`);

  const reader = sources.readers['output_handle'];
  const head = await measureHead(input, ports);
  ports = frozenPorts(ports, head.frozen);
  const { tools, budgetOf, fits, countInput } = metering(input, ports, head.tools);
  const { discovered, notices, systemMessage, task, pinnedDigest, pinnedTokens, ceiling, layers, memoryMessage, memoryCount } = head;
  const rankedMemories = sources.memories ?? [];
  const memoryCandidates =
    input.pinnedMemoryIds === undefined
      ? rankedMemories
      : input.pinnedMemoryIds.flatMap((id) => rankedMemories.filter((memory) => memory.id === id));
  const floorTokens = head.counted.inputTokens;

  const summaryItems: InputItem[] = sources.summary === undefined ? [] : [frozenItem(sources.summary.item)];
  const workingStateItems: InputItem[] =
    sources.summary === undefined || sources.workingState === undefined ? [] : [workingStateMessage(sources.workingState(readersOffered(sources.readers, tools)))];
  const prefixDigest = chainTail(digestChain({ scope: 'prefix', tools }, [...layers, ...summaryItems]));

  const roomLeft = ceiling - floorTokens;
  const itemCap = itemCapFor(capabilities, roomLeft);
  const callNames = new Map<string, string>();
  const countContextFor = (callId: string): ItemCountContext => {
    const name = callNames.get(callId);
    return { callNames: name === undefined ? {} : { [callId]: name }, withTools: input.tools !== 'none' };
  };
  const shellMessage = (text: string): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const shellItems: InputItem[] = [];
  for (const text of sources.taskShell ?? []) {
    const count = (candidate: string): Promise<number> => meter.countItem(shellMessage(candidate), countContextFor(''));
    const handle = blobs.handleFor(text);
    const fitted = await fitToTokens({ text, cap: itemCap, handle, reader, count });
    if (fitted !== text) await blobs.put(text, { mediaType: BLOB_MEDIA_TYPE });
    shellItems.push(shellMessage(fitted));
  }
  const taskItems = [...shellItems, task];
  const reports = new Map<string, { eviction: ContextEviction; state: OutputState }>();
  const referenceReports: ContextEviction[] = [];
  const reported = (): ContextEviction[] => [
    ...[...reports.values()].filter(({ state }) => state.persisted).map(({ eviction }) => eviction),
    ...referenceReports,
  ];
  const identicalActive = input.outputFormatters?.includes('identicalOutput') === true;
  const shown = (slot: Slot): InputItem => slot.output?.reference?.item ?? slot.item;

  const ensureHandle = async (state: OutputState): Promise<boolean> => {
    if (state.persisted) return false;
    state.handle = (await blobs.put(state.text, { mediaType: BLOB_MEDIA_TYPE })).handle;
    state.persisted = true;
    return true;
  };

  const renderKept = async (state: OutputState, handle: string, kept: number): Promise<InputItem> => {
    const rendered = withOutput(state.original, state.render.enclose(cutChars(state.text, kept, handle, state.tokens, reader)));
    state.renderedTokens = await meter.countItem(rendered, countContextFor(state.callId));
    state.keptChars = kept;
    return rendered;
  };

  const truncation = async (state: OutputState, handle: string): Promise<{ rendered: InputItem; tokens: number; kept: number }> => {
    const count = (text: string): Promise<number> => meter.countItem(withOutput(state.original, state.render.enclose(text)), countContextFor(state.callId));
    let kept = state.text.length;
    const text = await fitToTokens({ text: state.text, cap: itemCap, handle, reader, count, onCut: (keptChars) => void (kept = keptChars) });
    return { rendered: withOutput(state.original, state.render.enclose(text)), tokens: await count(text), kept };
  };

  const truncate = async (state: OutputState, handle: string): Promise<InputItem> => {
    const { rendered, tokens, kept } = await truncation(state, handle);
    state.renderedTokens = tokens;
    state.keptChars = kept;
    return rendered;
  };

  const refreshReferences = async (): Promise<void> => {
    if (!identicalActive) return;
    const states = slots.flatMap((slot) => (slot.output === undefined ? [] : [slot.output]));
    const referents = identicalReferents(states.map((state) => ({ callId: state.callId, text: state.text, full: state.mode === 'full' })));
    for (const state of states) {
      const referent = referents.get(state.callId);
      if (referent === undefined) {
        state.reference = undefined;
        continue;
      }
      if (state.reference?.to === referent) continue;
      const item = withOutput(state.original, identicalMarker(referent, blobs.handleFor(state.text), reader));
      state.reference = { to: referent, item, tokens: await meter.countItem(item, countContextFor(state.callId)) };
    }
  };

  const measureAssembled = async (): Promise<MeterCount> => {
    await refreshReferences();
    return countInput(assemble(), true);
  };

  const referrersAfterEviction = async (referrers: readonly OutputState[]): Promise<number> => {
    let referent: string | undefined;
    let tokens = 0;
    for (const referrer of referrers) {
      if (referrer.tokens > itemCap) {
        tokens += (await truncation(referrer, referrer.handle ?? blobs.handleFor(referrer.text))).tokens;
      } else if (referent === undefined) {
        referent = referrer.callId;
        tokens += referrer.tokens;
      } else {
        const item = withOutput(referrer.original, identicalMarker(referent, blobs.handleFor(referrer.text), reader));
        tokens += await meter.countItem(item, countContextFor(referrer.callId));
      }
    }
    return tokens;
  };

  const truncateSlot = async (slot: Slot, state: OutputState): Promise<void> => {
    await ensureHandle(state);
    const handle = state.handle as string;
    slot.item = await truncate(state, handle);
    state.mode = 'truncated';
    reports.set(state.callId, {
      eviction: { callId: state.callId, handle, kind: 'truncated', ...(input.observedCapacity === true ? { keptChars: state.keptChars as number } : {}) },
      state,
    });
  };

  const restoreFull = (slot: Slot, state: OutputState): void => {
    slot.item = state.render.full;
    state.mode = 'full';
    state.renderedTokens = state.tokens;
    state.keptChars = undefined;
    reports.delete(state.callId);
  };

  const rerenderFrom = async (firstSlot: number): Promise<void> => {
    for (const [index, slot] of slots.entries()) {
      const state = slot.output;
      if (index < firstSlot || state === undefined || state.mode === 'omitted') continue;
      if (state.tokens > itemCap) await truncateSlot(slot, state);
      else if (state.mode === 'truncated') restoreFull(slot, state);
    }
  };

  const historyItems = historyItemsOf(sources);
  const harnessTools = harnessToolsOf(input);

  for (const entry of historyItems) {
    if (entry.item.type === 'function_call') callNames.set(entry.item.call_id, entry.item.name);
  }

  if (sources.summary !== undefined) {
    const dangling = findDanglingOutput(historyItems);
    if (dangling !== undefined) {
      throw new RangeError(
        `summary boundary splits call ${dangling.callId}: output at seq ${dangling.seq} has no retained function_call`,
      );
    }
  }

  const shape = shapeOf(historyItems, sources.taskSeq);
  const { turnCount, currentTurn, lastStep } = shape;
  const slots: Slot[] = [];
  for (const [index, entry] of historyItems.entries()) {
    const { turn, step } = shape.positions[index] as (typeof shape.positions)[number];
    const slot: Slot = { seq: entry.seq, turn, step, item: entry.item };
    if (entry.item.type === 'function_call_output') {
      const original = entry.item;
      const text = outputTextOf(original.output);
      const render = outputRenderOf(original, callNames.get(original.call_id), harnessTools, entry.pointer, input.fence);
      slot.item = render.full;
      const tokens = entry.omittedTokens ?? (await meter.countItem(render.full, countContextFor(original.call_id)));
      const state: OutputState = {
        original,
        render,
        callId: original.call_id,
        text,
        tokens,
        handle: 'handle' in entry ? entry.handle : undefined,
        persisted: 'handle' in entry,
        reference: undefined,
        mode: 'full',
        renderedTokens: tokens,
        keptChars: undefined,
      };
      slot.output = state;
      const frozenKept = input.forms?.get(state.callId);
      if (evicted.has(state.callId)) {
        const created = await ensureHandle(state);
        const handle = state.handle as string;
        slot.item = withOutput(original, omittedMarker(tokens, handle, reader));
        state.mode = 'omitted';
        state.renderedTokens = await meter.countItem(slot.item, countContextFor(state.callId));
        if (created) reports.set(state.callId, { eviction: { callId: state.callId, handle, kind: 'omitted', tokens: state.tokens }, state });
      } else if (frozenKept !== undefined) {
        await ensureHandle(state);
        slot.item = await renderKept(state, state.handle as string, frozenKept);
        state.mode = 'truncated';
      } else if (input.renderedFull?.has(state.callId) === true) {
      } else if (tokens > itemCap) {
        await truncateSlot(slot, state);
      }
    }
    slots.push(slot);
  }
  const rungs = protectionRungsOf(shape, requestedKeepTurns, requestedKeepSteps);
  const lastIndex = rungs.length - 1;
  const levelIndex = Math.min(requestedLevel, lastIndex);
  const lastLevel = levelIndex === lastIndex;
  const { protection, protectedSlots } = rungs[levelIndex] as (typeof rungs)[number];

  const protectionNotices: ContextNotice[] = [];
  if (protection.keepTurns < requestedKeepTurns && turnCount > protection.keepTurns) {
    protectionNotices.push({
      code: 'recent_turns_shrunk',
      message: 'recent turns were reduced to the current turn because the context budget was exceeded',
      reduction: { turn: currentTurn, from: requestedKeepTurns, to: protection.keepTurns },
    });
  }
  if (protection.keepSteps < requestedKeepSteps) {
    protectionNotices.push({
      code: 'recent_steps_shrunk',
      message: `recent steps of the current turn were reduced from ${requestedKeepSteps} to ${protection.keepSteps} because the context budget was exceeded`,
      reduction: { turn: currentTurn, from: requestedKeepSteps, to: protection.keepSteps },
    });
  }

  const withTask = (kept: readonly Slot[]): InputItem[] => {
    const items = kept.map(shown);
    const taskIndex = kept.findIndex((slot) => slot.seq > sources.taskSeq);
    return taskIndex < 0 ? [...items, ...taskItems] : [...items.slice(0, taskIndex), ...taskItems, ...items.slice(taskIndex)];
  };

  const assemble = (): InputItem[] => [...layers, ...summaryItems, ...withTask(slots), ...workingStateItems, ...trailing];

  let firstEvicted: number | undefined;

  const evictOldest = async (): Promise<boolean> => {
    await refreshReferences();
    for (const [index, slot] of slots.entries()) {
      const state = slot.output;
      if (state === undefined || state.mode === 'omitted' || state.reference !== undefined || protectedSlots.has(index)) continue;
      const copies = slots.flatMap((other, otherIndex) =>
        other.output?.reference?.to === state.callId ? [{ slot: other, state: other.output, index: otherIndex }] : [],
      );
      const group = [{ slot, state, index }, ...copies.filter((copy) => !protectedSlots.has(copy.index))];
      const staying = copies.filter((copy) => protectedSlots.has(copy.index)).map((copy) => copy.state);
      const markers = new Map<OutputState, { handle: string; probe: InputItem }>();
      for (const member of group) {
        const handle = member.state.handle ?? blobs.handleFor(member.state.text);
        markers.set(member.state, { handle, probe: withOutput(member.state.original, omittedMarker(member.state.tokens, handle, reader)) });
      }
      let tokensBefore = state.renderedTokens + copies.reduce((sum, copy) => sum + (copy.state.reference as OutputReference).tokens, 0);
      let tokensAfter = await referrersAfterEviction(staying);
      for (const member of group) {
        tokensAfter += await meter.countItem((markers.get(member.state) as { probe: InputItem }).probe, countContextFor(member.state.callId));
      }
      if (tokensAfter >= tokensBefore) continue;
      for (const member of group) {
        const { handle, probe } = markers.get(member.state) as { handle: string; probe: InputItem };
        member.state.handle = handle;
        member.slot.item = probe;
        member.state.mode = 'omitted';
        member.state.renderedTokens = await meter.countItem(probe, countContextFor(member.state.callId));
        reports.set(member.state.callId, { eviction: { callId: member.state.callId, handle, kind: 'omitted', tokens: member.state.tokens }, state: member.state });
        firstEvicted = firstEvicted === undefined ? member.index : Math.min(firstEvicted, member.index);
      }
      return true;
    }
    return false;
  };

  const passSnapshot = () => ({
    items: slots.map((slot) => slot.item),
    states: slots.flatMap((slot) => (slot.output === undefined ? [] : [{ state: slot.output, fields: { ...slot.output } }])),
    reports: new Map(reports),
    firstEvicted,
    counted: counts.length,
  });

  const restorePass = (snapshot: ReturnType<typeof passSnapshot>): void => {
    for (const [index, slot] of slots.entries()) slot.item = snapshot.items[index] as InputItem;
    for (const { state, fields } of snapshot.states) Object.assign(state, fields);
    reports.clear();
    for (const [callId, report] of snapshot.reports) reports.set(callId, report);
    firstEvicted = snapshot.firstEvicted;
    counts.length = snapshot.counted;
  };

  const persistReferences = async (): Promise<void> => {
    for (const slot of slots) {
      const state = slot.output;
      if (state?.reference === undefined) continue;
      if (input.recordedReferences.has(state.callId)) continue;
      const handle = blobs.handleFor(state.text);
      await blobs.put(state.text, { mediaType: BLOB_MEDIA_TYPE });
      referenceReports.push({ callId: state.callId, handle, kind: 'reference' });
    }
  };

  const persistEvictions = async (throughIndex: number): Promise<void> => {
    for (const [index, slot] of slots.entries()) {
      if (index > throughIndex || slot.output?.mode !== 'omitted') continue;
      await ensureHandle(slot.output);
    }
  };

  const cutIndexes = (): number[] => {
    const firstProtected = Math.min(slots.length, ...protectedSlots);
    const cuts: number[] = [];
    for (const [index, slot] of slots.entries()) {
      if (index >= firstProtected) break;
      const next = slots[index + 1];
      const endsStep = next === undefined ? slot.turn !== currentTurn : next.turn !== slot.turn || next.step !== slot.step;
      if (endsStep) cuts.push(index);
    }
    return cuts;
  };

  const workingStateGrowth = async (): Promise<number> => {
    if (sources.projectedWorkingState === undefined) return 0;
    const projected = await meter.countItem(workingStateMessage(sources.projectedWorkingState), countContextFor(''));
    const current = workingStateItems[0] === undefined ? 0 : await meter.countItem(workingStateItems[0], countContextFor(''));
    return Math.max(0, projected - current);
  };

  const compactionFor = async (
    kind: 'proactive' | 'forced',
    deficit: number,
  ): Promise<{ plan: CompactionPlan } | { blocked: CompactionBlock } | { declined: true }> => {
    const cuts = cutIndexes();
    if (cuts.length === 0) {
      const lastStepItems = slots.filter((slot) => slot.turn === currentTurn && slot.step === lastStep).map(shown);
      const protectedCounted = await countInput([...layers, task, ...lastStepItems]);
      return lastStepItems.length > 0 && protectedCounted.inputTokens > ceiling
        ? {
            blocked: {
              reason: 'protected_step_exceeds_room',
              message: `the latest step alone needs ${protectedCounted.inputTokens} tokens, more than the ${ceiling} that fit`,
            },
          }
        : {
            blocked: {
              reason: 'no_step_boundary_outside_protection',
              message: 'every step boundary lies inside the protected recent steps or before the summary',
            },
          };
    }
    const target = ports.compactionTarget === undefined ? (input.calibration === undefined ? capabilities : withCalibration(capabilities, input.calibration)) : await ports.compactionTarget();
    const summaryCap = Math.min(summaryTokenCapFor(capabilities, roomLeft), largestSummaryCapFor(target));
    const summaryCeiling = summaryInputCeilingFor(target);
    const promptTokens = summaryPromptTokensFor(input.compactionFocus);
    const growth = await workingStateGrowth();
    const item = summaryItemTokensFor(summaryCap) + growth;
    const layersOnly = (await countInput(layers)).inputTokens;
    const previousSummary = summaryItems.length === 0 ? 0 : (await countInput([...layers, ...summaryItems])).inputTokens - layersOnly;
    const taskTokens = floorTokens - layersOnly;
    let overBudget: CompactionBlock | undefined;
    for (const cutIndex of cuts.toReversed()) {
      const prefix = slots.slice(0, cutIndex + 1);
      const taskInside = prefix.some((slot) => slot.seq > sources.taskSeq);
      const counted = await countInput([...layers, ...summaryItems, ...prefix.map(shown)]);
      const region = counted.inputTokens - layersOnly;
      const regionWithTask = region + (taskInside ? taskTokens : 0);
      if (regionWithTask + promptTokens + summaryCap > summaryCeiling) {
        overBudget = {
          reason: 'region_exceeds_summary_input_budget',
          message: `the compactable region needs ${regionWithTask} tokens plus ${promptTokens} for the instructions and ${summaryCap} for the summary, more than the ${summaryCeiling} a summary request may hold`,
        };
        continue;
      }
      const closes = kind === 'proactive' ? region >= proactiveGainFor(item, previousSummary) : region - item >= deficit;
      if (!closes) {
        return kind === 'proactive'
          ? { declined: true }
          : {
              blocked: {
                reason: 'deficit_not_closed',
                message: `the latest compactable region of ${region} tokens would free ${region - item} after a summary of ${item}, but ${deficit} are needed`,
              },
            };
      }
      const unpaired = findUnpairedCalls(prefix);
      if (unpaired.length > 0) {
        throw new Error(`compaction cut at seq ${(slots[cutIndex] as Slot).seq} leaves unpaired calls: ${unpaired.map((call) => call.callId).join(', ')}`);
      }
      await persistEvictions(cutIndex);
      const throughSeq = (slots[cutIndex] as Slot).seq;
      const items = prefix.map(shown);
      const taskAt = prefix.findIndex((slot) => slot.seq > sources.taskSeq);
      const compactionInput = taskAt < 0 ? items : [...items.slice(0, taskAt), ...taskItems, ...items.slice(taskAt)];
      return {
        plan: {
          throughSeq,
          input: [...summaryItems, ...compactionInput],
          summaryTokenCap: summaryCap,
          ...(input.compactionFocus === undefined ? {} : { focus: input.compactionFocus }),
          pinnedText: [...layers, task].map((item) => textOfItem(item)).join('\n'),
          notices: protectionNotices,
          tokens: { input: total.inputTokens, replaced: region, workingStateGrowth: growth, request: regionWithTask + promptTokens },
          rebuilt: {
            before: [...layers],
            after: [
              ...withTask(slots.slice(cutIndex + 1)),
              ...(sources.projectedWorkingState === undefined ? workingStateItems : [workingStateMessage(sources.projectedWorkingState)]),
              ...trailing,
            ],
            tools: [...tools],
          },
        },
      };
    }
    return { blocked: overBudget as CompactionBlock };
  };

  const cachePrefix = input.layout === 'cachePrefix';
  const admitted = admittedFloor(input);
  let total = await measureAssembled();
  const inputBudgetAtZero = budgetFor(capabilities, 0).I;
  const boundOfBuild = (tokens: number): number => counts.reduce((widest, counted) => Math.max(widest, counted.underAt(tokens)), 0);
  const exactHighMark = (): number => floorTokens + floorRatio(COMPACT_AT, ceiling - floorTokens);
  const pinnedBoundError = async (maxInput: number | undefined, boundAtZero: number): Promise<PinnedBoundError> =>
    new PinnedBoundError({
      pinnedTokens,
      ceiling,
      breakdown: await breakdownOf(ports, systemMessage, layers, head.governing, task, tools),
      inputBudget: inputBudgetAtZero,
      boundAtZero,
      maxInput,
    });
  const highMarkNow = async (): Promise<number> => {
    if (!cachePrefix) return exactHighMark();
    const maxInputB = maxInputFor({ ceiling, inputBudget: inputBudgetAtZero, errorBoundAt: boundOfBuild });
    if (maxInputB !== undefined) return Math.min(exactHighMark(), maxInputB);
    if (admitted) return exactHighMark();
    throw await pinnedBoundError(undefined, boundOfBuild(0));
  };
  let highMark = await highMarkNow();
  const loadOf = (counted: MeterCount): number => counted.inputTokens + counted.underAt(counted.inputTokens);
  if (total.inputTokens > highMark || !fits(total)) {
    const unevicted = total;
    const snapshot = passSnapshot();
    const pass = evictionPassFor(input.layout, { floorTokens, highMark });
    if (pass.kind === 'batch') {
      while (await evictOldest()) continue;
      if (firstEvicted !== undefined && (input.forms !== undefined || input.renderedFull !== undefined)) await rerenderFrom(firstEvicted);
      total = await measureAssembled();
    } else {
      while ((total.inputTokens > pass.lowMark || !fits(total)) && (await evictOldest())) {
        if (input.forms !== undefined || input.renderedFull !== undefined) await rerenderFrom(firstEvicted as number);
        total = await measureAssembled();
      }
    }
    const kept = fits(total) || (!fits(unevicted) && loadOf(total) < loadOf(unevicted));
    if (!kept) {
      restorePass(snapshot);
      total = unevicted;
    }
    highMark = await highMarkNow();
  }

  if (!fits(total)) {
    const inputBudget = budgetFor(capabilities, 0).I;
    const maxInput = maxInputFor({ ceiling, inputBudget, errorBoundAt: total.freshUnderAt });
    if (!admitted && (maxInput === undefined || maxInput < pinnedTokens)) throw await pinnedBoundError(maxInput, total.underAt(0));
    const outcome = await compactionFor('forced', maxInput === undefined ? total.inputTokens : total.inputTokens - maxInput);
    if (lastLevel) await persistEvictions(slots.length);
    throw new ContextOverflowError({
      inputTokens: total.inputTokens,
      inputBudget: budgetOf(total).I,
      ceiling,
      pinnedTokens,
      floorTokens,
      level: levelIndex,
      lastLevel,
      protection,
      breakdown: lastLevel ? await breakdownOf(ports, systemMessage, layers, head.governing, task, tools) : undefined,
      evictions: reported(),
      compaction: 'plan' in outcome ? outcome.plan : undefined,
      compactionBlockedBy: 'blocked' in outcome ? outcome.blocked : undefined,
    });
  }

  await persistReferences();
  await persistEvictions(slots.length);

  notices.push(...protectionNotices);

  const hint =
    input.compactNow === true
      ? await compactionFor('forced', MANUAL_COMPACTION_GAIN)
      : levelIndex === 0 && total.inputTokens > highMark
        ? await compactionFor('proactive', 0)
        : undefined;
  const finalInput = assemble();
  const arrivalsStart = cachePrefix ? head.pinnedLayers.length + (memoryMessage === undefined ? 0 : 1) : layers.length - head.arrivals.length;
  const zones: ContextZones = {
    stableEnd: head.pinnedLayers.length,
    arrivalsStart,
    arrivalsEnd: arrivalsStart + head.arrivals.length,
    fixedEnd: layers.length,
    historyEnd: finalInput.length - workingStateItems.length - trailing.length,
    arrivalKeys: head.arrivals.map((entry) => entry.key),
  };
  const layerByItem = new Map<InputItem, TaggedItem['layer']>();
  layerByItem.set(task, 'history.user');
  for (const message of head.catalogMessages) layerByItem.set(message, 'skills');
  for (const message of head.mandateMessages) layerByItem.set(message, 'instructions');
  for (const entry of head.arrivals) layerByItem.set(entry.message, entry.layer);
  for (const file of [discovered.user, discovered.root]) if (file !== undefined) layerByItem.set(file.message, 'instructions');
  for (const message of head.governing) layerByItem.set(message, 'governing');
  if (memoryMessage !== undefined) layerByItem.set(memoryMessage, 'memories');
  for (const item of summaryItems) layerByItem.set(item, 'summary');
  for (const item of workingStateItems) layerByItem.set(item, 'workingState');
  for (const item of trailing) layerByItem.set(item, 'notices');
  layerByItem.set(systemMessage, 'system');
  const tagged = finalInput.map((item): TaggedItem => ({ item, layer: layerByItem.get(item) ?? historyLayerOf(item) }));
  const anatomy = await anatomyOf(ports.meter, tools, tagged, total, (item) =>
    countContextFor(item.type === 'function_call_output' ? item.call_id : ''),
  );
  return {
    input: finalInput,
    anatomy,
    tools,
    maxOutputTokens: budgetOf(total).R,
    inputTokens: total.inputTokens,
    budget: budgetOf(total),
    prefixDigest,
    pinnedDigest,
    inputDigest: total.inputDigest,
    evictions: reported(),
    ...(hint !== undefined && 'plan' in hint ? { compaction: hint.plan } : {}),
    ...(hint !== undefined && 'blocked' in hint ? { compactionBlockedBy: hint.blocked } : {}),
    lastLevel,
    notices,
    loadedInstructions: [discovered.user, discovered.root, ...head.instructionFiles]
      .filter((file) => file !== undefined)
      .map((file) => file.instruction),
    loadedMemoryIds: memoryCandidates.slice(0, memoryCount).map((memory) => memory.id),
    loadedGoverning: loadedGoverningOf(sources.governing),
    zones,
    pinnedTokens,
  };
};
