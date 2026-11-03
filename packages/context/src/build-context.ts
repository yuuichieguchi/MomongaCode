import { SUMMARY_PROMPT_TOKENS, findDanglingOutput, findUnpairedCalls, summaryItemTokensFor, summaryTokenCapFor } from '@momonga/protocol';
import type { FunctionCallOutputInputItem, FunctionTool, InputItem, MessageInputItem } from '@momonga/protocol';
import { MIN_ROOM_TOKENS, budgetFor, inputCeilingFor, itemCapFor, memoryBudgetFor, summaryInputCeilingFor, pinnedFloorFor } from './budget.ts';
import { anatomyOf, historyLayerOf } from './anatomy.ts';
import type { TaggedItem } from './anatomy.ts';
import { chainTail, digestChain, frozenItem } from './digests.ts';
import { ContextOverflowError, PinnedBoundError, PinnedOverflowError, PinnedRoomError, PrefixChangedError } from './errors.ts';
import { governingMessageOf, governingNoticesOf, loadedGoverningOf } from './governing.ts';
import { discoverInstructions } from './instructions.ts';
import type { DiscoveredInstructions, LoadedInstructionFile } from './instructions.ts';
import { DEFAULT_KEEP_RECENT_STEPS, DEFAULT_KEEP_RECENT_TURNS, positiveInteger, protectionRungsOf, retainedHistoryOf, shapeOf } from './levels.ts';
import { textOfItem } from './item-text.ts';
import { renderMemories } from './memory.ts';
import { workingStateMessage } from './working-state.ts';
import { heldSkillOf, pointToHeldSkill } from './skill-output.ts';
import { HANDLE_READER_TOOL, headAndTail, omittedMarker, outputTextOf, truncatedMarker, withOutput } from './tool-output.ts';
import type {
  BuildContextInput,
  BuildContextPorts,
  BuiltContext,
  CompactionBlock,
  CompactionPlan,
  ContextEviction,
  ContextNotice,
  ItemCountContext,
  MeterCount,
  PinnedBreakdown,
  PinnedMeasure,
  ProtectionLevel,
} from './types.ts';

const DEFAULT_COMPACT_AT = 0.7;
const COMPACTION_MIN_GAIN = 2;
const EVICT_LOW_WATER = 0.5;
const BLOB_MEDIA_TYPE = 'text/plain';

type OutputState = {
  original: FunctionCallOutputInputItem;
  callId: string;
  text: string;
  tokens: number;
  handle: string | undefined;
  persisted: boolean;
  mode: 'full' | 'truncated' | 'omitted';
  renderedTokens: number;
};

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
  governing: MessageInputItem[];
  pinnedDigest: string;
  pinnedTokens: number;
  ceiling: number;
  room: number;
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

const candidateToolsOf = (input: BuildContextInput): FunctionTool[] => (input.tools === 'none' ? [] : [...input.sources.tools]);

const holdsHandles = (input: BuildContextInput): boolean =>
  input.evicted.size > 0 ||
  retainedHistoryOf(input.sources.history, input.sources.summary).some((entry) => entry.handle !== undefined || entry.item.type === 'function_call_output');

const requiredToolsOf = (input: BuildContextInput, candidates: readonly FunctionTool[]): FunctionTool[] =>
  holdsHandles(input) ? candidates.filter((tool) => tool.name === HANDLE_READER_TOOL) : [];

const hostsFirst = (tools: readonly FunctionTool[], hostOf: Readonly<Record<string, string>>): FunctionTool[] => {
  const depthOf = (name: string, seen: ReadonlySet<string>): number => {
    const host = hostOf[name];
    return host === undefined || seen.has(host) ? 0 : 1 + depthOf(host, new Set([...seen, name]));
  };
  return tools
    .map((tool, index) => ({ tool, index, depth: depthOf(tool.name, new Set<string>()) }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map(({ tool }) => tool);
};

const metering = (input: BuildContextInput, ports: BuildContextPorts, tools: readonly FunctionTool[]) => {
  const { capabilities } = input;
  const budgetOf = (counted: MeterCount) => budgetFor(capabilities, counted.errorBound);
  const fits = (counted: MeterCount): boolean => counted.inputTokens <= budgetOf(counted).I;
  const countInput = (items: readonly InputItem[]): Promise<MeterCount> => ports.meter.count({ input: items, tools });
  return { tools: [...tools], budgetOf, fits, countInput };
};

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

const measureHead = async (input: BuildContextInput, ports: BuildContextPorts): Promise<Head> => {
  const { capabilities, sources } = input;
  const candidates = candidateToolsOf(input);
  const discovered = await discoverInstructions({
    reader: ports.instructions,
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
  const pinnedLayers: InputItem[] = [systemMessage, ...instructionMessages];
  const pinned: InputItem[] = [...pinnedLayers, task];
  const pinnedDigest = chainTail(digestChain({ scope: 'pinned-items' }, pinned));
  if (input.expectedPinnedDigest !== undefined && input.expectedPinnedDigest !== pinnedDigest) {
    throw new PrefixChangedError(input.expectedPinnedDigest, pinnedDigest);
  }
  const governing = governingMessageOf(sources.governing);
  const ceiling = inputCeilingFor(capabilities);
  const toolFloor = pinnedFloorFor(capabilities);
  const countWith = (offered: readonly FunctionTool[]): Promise<MeterCount> =>
    ports.meter.count({ input: [...pinnedLayers, ...governing, task], tools: offered });
  const fitsFloor = (counted: MeterCount): boolean => metering(input, ports, candidates).fits(counted) && counted.inputTokens <= toolFloor;
  const stableFitsFloor = async (offered: readonly FunctionTool[]): Promise<boolean> =>
    fitsFloor(await ports.meter.count({ input: [...pinnedLayers, ...governing], tools: offered }));
  const hostOf = input.companions === undefined || input.companions.keepWithoutHost ? {} : input.companions.hostOf;
  const standsWith = (tool: FunctionTool, offered: readonly FunctionTool[]): boolean => {
    const host = hostOf[tool.name];
    return host === undefined || offered.some((other) => other.name === host);
  };
  const eligible = candidates.filter((tool) => standsWith(tool, candidates));
  let tools = eligible;
  let leftOut: string[] = [];
  let pinnedCounted: MeterCount | undefined;
  if (input.pinnedTokens === undefined) {
    if (!(await stableFitsFloor(eligible))) {
      const required = requiredToolsOf(input, eligible);
      const kept: FunctionTool[] = [...required];
      const droppedForRoom: string[] = [];
      for (const tool of hostsFirst(eligible, hostOf)) {
        if (required.includes(tool) || !standsWith(tool, kept)) continue;
        if (await stableFitsFloor([...kept, tool])) kept.push(tool);
        else droppedForRoom.push(tool.name);
      }
      if (kept.length > 0 || (await stableFitsFloor(kept))) {
        tools = eligible.filter((tool) => kept.includes(tool));
        leftOut = droppedForRoom;
      }
    }
    pinnedCounted = await countWith(tools);
  }
  const { fits } = metering(input, ports, tools);
  const toolNotices: ContextNotice[] = [];
  if (leftOut.length > 0) {
    toolNotices.push({
      code: 'tools_dropped',
      message: `Tools ${leftOut.join(', ')} were left out because the declared context window leaves no room for them`,
    });
  }
  const pinnedTokens = input.pinnedTokens ?? (pinnedCounted as MeterCount).inputTokens;
  if (pinnedTokens > ceiling || (pinnedCounted !== undefined && !fits(pinnedCounted))) {
    throw new PinnedOverflowError({ pinnedTokens, ceiling, breakdown: await breakdownOf(ports, systemMessage, instructionMessages, governing, task, tools) });
  }
  const room = ceiling - pinnedTokens;
  if (room < MIN_ROOM_TOKENS) {
    throw new PinnedRoomError({
      pinnedTokens,
      ceiling,
      room,
      minimum: MIN_ROOM_TOKENS,
      breakdown: await breakdownOf(ports, systemMessage, instructionMessages, governing, task, tools),
    });
  }
  return {
    discovered,
    notices: [...discovered.notices, ...governingNoticesOf(sources.governing), ...toolNotices],
    tools,
    systemMessage,
    task,
    pinnedLayers,
    catalogMessages,
    governing,
    pinnedDigest,
    pinnedTokens,
    ceiling,
    room,
  };
};

type FittedLayers = {
  skillMessages: MessageInputItem[];
  nested: LoadedInstructionFile[];
  layers: InputItem[];
  counted: MeterCount;
  layersWith(memory: MessageInputItem | undefined): InputItem[];
  floorOf(layerItems: readonly InputItem[]): InputItem[];
  exceeds(counted: MeterCount): boolean;
};

const fitLayers = async (input: BuildContextInput, ports: BuildContextPorts, head: Head): Promise<FittedLayers> => {
  const { sources } = input;
  const { tools, fits, countInput } = metering(input, ports, head.tools);
  const { systemMessage, task, pinnedLayers, governing, notices, ceiling } = head;
  const nested = [...head.discovered.nested];
  const skillMessages: MessageInputItem[] = sources.activatedSkills.map((skill) => ({
    type: 'message',
    role: 'developer',
    content: `Activated skill ${skill.name}:\n${skill.content}`,
  }));
  const layersWith = (memory: MessageInputItem | undefined): InputItem[] => [
    ...pinnedLayers,
    ...governing,
    ...(memory === undefined ? [] : [memory]),
    ...nested.map((file) => file.message),
    ...skillMessages,
  ];
  const floorOf = (layerItems: readonly InputItem[]): InputItem[] => [...layerItems, task];
  const exceeds = (counted: MeterCount): boolean => !fits(counted) || counted.inputTokens > ceiling;
  const leavesNoRoom = (counted: MeterCount): boolean => ceiling - counted.inputTokens < MIN_ROOM_TOKENS;
  let layers = layersWith(undefined);
  let counted = await countInput(floorOf(layers));
  while ((exceeds(counted) || leavesNoRoom(counted)) && nested.length > 0) {
    const dropped = nested.shift();
    if (dropped === undefined) break;
    notices.push({
      code: 'instructions_dropped',
      message: `${dropped.instruction.path} was dropped because the context budget was exceeded`,
    });
    layers = layersWith(undefined);
    counted = await countInput(floorOf(layers));
  }
  if (exceeds(counted)) {
    throw new PinnedOverflowError({
      pinnedTokens: counted.inputTokens,
      ceiling,
      breakdown: await breakdownOf(ports, systemMessage, layers, governing, task, tools),
    });
  }
  if (leavesNoRoom(counted)) {
    throw new PinnedRoomError({
      pinnedTokens: counted.inputTokens,
      ceiling,
      room: ceiling - counted.inputTokens,
      minimum: MIN_ROOM_TOKENS,
      breakdown: await breakdownOf(ports, systemMessage, layers, governing, task, tools),
    });
  }
  return { skillMessages, nested, layers, counted, layersWith, floorOf, exceeds };
};

export const measureLayers = async (input: BuildContextInput, ports: BuildContextPorts): Promise<void> => {
  await fitLayers(input, ports, await measureHead(input, ports));
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

export const buildContext = async (input: BuildContextInput, ports: BuildContextPorts): Promise<BuiltContext> => {
  const { capabilities, sources, evicted } = input;
  const { meter, blobs } = ports;
  const trailing = [...(input.trailing ?? [])];
  const compactAt = input.compactAt ?? DEFAULT_COMPACT_AT;
  const requestedKeepTurns = positiveInteger('keepRecentTurns', input.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS);
  const requestedKeepSteps = positiveInteger('keepRecentSteps', input.keepRecentSteps ?? DEFAULT_KEEP_RECENT_STEPS);
  const requestedLevel = input.level ?? 0;
  if (!Number.isInteger(requestedLevel) || requestedLevel < 0) throw new RangeError(`level must be a non-negative integer, received ${requestedLevel}`);

  const head = await measureHead(input, ports);
  const { tools, budgetOf, fits, countInput } = metering(input, ports, head.tools);
  const { discovered, notices, systemMessage, task, pinnedDigest, pinnedTokens, ceiling } = head;

  const fitted = await fitLayers(input, ports, head);
  const { nested, skillMessages, layersWith, floorOf, exceeds } = fitted;
  let layers = fitted.layers;
  let layersCounted = fitted.counted;
  let memoryMessage: MessageInputItem | undefined;
  const layersOf = (): InputItem[] => layersWith(memoryMessage);

  const memoryCandidates = sources.memories ?? [];
  let memoryCount = 0;
  if (memoryCandidates.length > 0) {
    const baseTokens = layersCounted.inputTokens;
    const memoryBudget = memoryBudgetFor(ceiling - baseTokens, input.memoryShare);
    const fitsWith = async (count: number): Promise<boolean> => {
      memoryMessage = {
        type: 'message',
        role: 'user',
        content: renderMemories(memoryCandidates.slice(0, count), memoryCandidates.length - count),
      };
      const counted = await countInput(floorOf(layersOf()));
      return !exceeds(counted) && ceiling - counted.inputTokens >= MIN_ROOM_TOKENS && counted.inputTokens - baseTokens <= memoryBudget;
    };
    if (await fitsWith(0)) {
      let low = 0;
      let high = memoryCandidates.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (await fitsWith(middle)) low = middle;
        else high = middle - 1;
      }
      memoryCount = low;
      await fitsWith(memoryCount);
    } else {
      memoryMessage = undefined;
    }
    if (memoryCount < memoryCandidates.length) {
      notices.push({
        code: 'memories_dropped',
        message: `${memoryCandidates.length - memoryCount} of ${memoryCandidates.length} saved memories were left out of the context because of its budget`,
      });
    }
    layers = layersOf();
    layersCounted = await countInput(floorOf(layers));
  }
  const floorTokens = layersCounted.inputTokens;

  const summaryItems: InputItem[] = sources.summary === undefined ? [] : [frozenItem(sources.summary.item)];
  const workingStateItems: InputItem[] =
    sources.summary === undefined || sources.workingState === undefined ? [] : [workingStateMessage(sources.workingState)];
  const prefixDigest = chainTail(digestChain({ scope: 'prefix', tools }, [...layers, ...summaryItems]));

  const roomLeft = ceiling - floorTokens;
  const itemCap = input.itemCap ?? itemCapFor(capabilities, roomLeft);
  const summaryCap = summaryTokenCapFor(capabilities, roomLeft);
  const callNames = new Map<string, string>();
  const countContextFor = (callId: string): ItemCountContext => {
    const name = callNames.get(callId);
    return { callNames: name === undefined ? {} : { [callId]: name }, withTools: input.tools !== 'none' };
  };
  const reports = new Map<string, { eviction: ContextEviction; state: OutputState }>();
  const reported = (): ContextEviction[] => [...reports.values()].filter(({ state }) => state.persisted).map(({ eviction }) => eviction);

  const ensureHandle = async (state: OutputState): Promise<boolean> => {
    if (state.persisted) return false;
    state.handle = (await blobs.put(state.text, { mediaType: BLOB_MEDIA_TYPE })).handle;
    state.persisted = true;
    return true;
  };

  const truncate = async (state: OutputState, handle: string): Promise<InputItem> => {
    const marker = truncatedMarker(state.tokens, handle);
    let kept = Math.floor((state.text.length * itemCap) / state.tokens);
    for (;;) {
      const rendered = withOutput(state.original, headAndTail(state.text, kept, marker));
      const tokens = await meter.countItem(rendered, countContextFor(state.callId));
      if (tokens <= itemCap || kept === 0) {
        state.renderedTokens = tokens;
        return rendered;
      }
      kept = Math.max(0, Math.min(kept - 1, Math.floor((kept * itemCap) / tokens)));
    }
  };

  const historyItems = retainedHistoryOf(sources.history, sources.summary).map((entry) => {
    const item = frozenItem(entry.item);
    const held = heldSkillOf(item, sources.activatedSkills) !== undefined;
    return {
      seq: entry.seq,
      item: pointToHeldSkill(item, sources.activatedSkills),
      ...(entry.handle === undefined || held ? {} : { handle: entry.handle }),
    };
  });

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
      const tokens = await meter.countItem(original, countContextFor(original.call_id));
      const state: OutputState = {
        original,
        callId: original.call_id,
        text,
        tokens,
        handle: 'handle' in entry ? entry.handle : undefined,
        persisted: 'handle' in entry,
        mode: 'full',
        renderedTokens: tokens,
      };
      slot.output = state;
      if (evicted.has(state.callId)) {
        const created = await ensureHandle(state);
        const handle = state.handle as string;
        slot.item = withOutput(original, omittedMarker(tokens, handle));
        state.mode = 'omitted';
        state.renderedTokens = await meter.countItem(slot.item, countContextFor(state.callId));
        if (created) reports.set(state.callId, { eviction: { callId: state.callId, handle, kind: 'omitted' }, state });
      } else if (tokens > itemCap) {
        await ensureHandle(state);
        const handle = state.handle as string;
        slot.item = await truncate(state, handle);
        state.mode = 'truncated';
        reports.set(state.callId, { eviction: { callId: state.callId, handle, kind: 'truncated' }, state });
      }
    }
    slots.push(slot);
  }
  const rungs = protectionRungsOf(shape, requestedKeepTurns, requestedKeepSteps);
  const lastIndex = rungs.length - 1;
  const levelIndex = Math.min(requestedLevel, lastIndex);
  const lastLevel = levelIndex === lastIndex;
  const { protection, protectedSlots } = rungs[levelIndex] as (typeof rungs)[number];

  const assemble = (): InputItem[] => {
    const items = slots.map((slot) => slot.item);
    const taskIndex = slots.findIndex((slot) => slot.seq > sources.taskSeq);
    const ordered = taskIndex < 0 ? [...items, task] : [...items.slice(0, taskIndex), task, ...items.slice(taskIndex)];
    return [...layers, ...summaryItems, ...ordered, ...workingStateItems, ...trailing];
  };

  const evictOldest = async (): Promise<boolean> => {
    for (const [index, slot] of slots.entries()) {
      const state = slot.output;
      if (state === undefined || state.mode === 'omitted' || protectedSlots.has(index)) continue;
      const handle = state.handle ?? blobs.handleFor(state.text);
      const probe = withOutput(state.original, omittedMarker(state.tokens, handle));
      if ((await meter.countItem(probe, countContextFor(state.callId))) >= state.renderedTokens) continue;
      state.handle = handle;
      slot.item = probe;
      state.mode = 'omitted';
      state.renderedTokens = await meter.countItem(slot.item, countContextFor(state.callId));
      reports.set(state.callId, { eviction: { callId: state.callId, handle, kind: 'omitted' }, state });
      return true;
    }
    return false;
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
      const lastStepItems = slots.filter((slot) => slot.turn === currentTurn && slot.step === lastStep).map((slot) => slot.item);
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
    const item = summaryItemTokensFor(summaryCap) + (await workingStateGrowth());
    const layersOnly = (await countInput(layers)).inputTokens;
    const taskTokens = floorTokens - layersOnly;
    const summaryCeiling = summaryInputCeilingFor(capabilities);
    let overBudget: CompactionBlock | undefined;
    for (const cutIndex of cuts.toReversed()) {
      const prefix = slots.slice(0, cutIndex + 1);
      const taskInside = prefix.some((slot) => slot.seq > sources.taskSeq);
      const counted = await countInput([...layers, ...summaryItems, ...prefix.map((slot) => slot.item)]);
      const region = counted.inputTokens - layersOnly;
      const regionWithTask = region + (taskInside ? taskTokens : 0);
      if (regionWithTask + SUMMARY_PROMPT_TOKENS + summaryCap > summaryCeiling) {
        overBudget = {
          reason: 'region_exceeds_summary_input_budget',
          message: `the compactable region needs ${regionWithTask} tokens plus ${SUMMARY_PROMPT_TOKENS} for the instructions and ${summaryCap} for the summary, more than the ${summaryCeiling} a summary request may hold`,
        };
        continue;
      }
      const closes = kind === 'proactive' ? region >= COMPACTION_MIN_GAIN * item : region - item >= deficit;
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
      const items = prefix.map((slot) => slot.item);
      const taskAt = prefix.findIndex((slot) => slot.seq > sources.taskSeq);
      const compactionInput = taskAt < 0 ? items : [...items.slice(0, taskAt), task, ...items.slice(taskAt)];
      return {
        plan: {
          throughSeq,
          input: [...summaryItems, ...compactionInput],
          summaryTokenCap: summaryCap,
          pinnedText: [...layers, task].map((item) => textOfItem(item)).join('\n'),
        },
      };
    }
    return { blocked: overBudget as CompactionBlock };
  };

  let total = await countInput(assemble());
  const highMark = floorTokens + compactAt * (ceiling - floorTokens);
  const lowMark = floorTokens + EVICT_LOW_WATER * (highMark - floorTokens);
  if (total.inputTokens > highMark || !fits(total)) {
    while ((total.inputTokens > lowMark || !fits(total)) && (await evictOldest())) total = await countInput(assemble());
  }

  if (!fits(total)) {
    const inputBudget = budgetFor(capabilities, 0).I;
    const maxInput = maxInputFor({ ceiling, inputBudget, errorBoundAt: total.errorBoundAt });
    if (maxInput === undefined || maxInput < pinnedTokens) {
      throw new PinnedBoundError({
        pinnedTokens,
        ceiling,
        breakdown: await breakdownOf(ports, systemMessage, layers, head.governing, task, tools),
        inputBudget,
        boundAtZero: total.errorBoundAt(0),
        maxInput,
      });
    }
    const outcome = await compactionFor('forced', total.inputTokens - maxInput);
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

  await persistEvictions(slots.length);

  if (levelIndex > 0) {
    if (protection.keepTurns < requestedKeepTurns && turnCount > protection.keepTurns) {
      notices.push({
        code: 'recent_turns_shrunk',
        message: 'recent turns were reduced to the current turn because the context budget was exceeded',
      });
    }
    if (protection.keepSteps < requestedKeepSteps) {
      notices.push({
        code: 'recent_steps_shrunk',
        message: `recent steps of the current turn were reduced from ${requestedKeepSteps} to ${protection.keepSteps} because the context budget was exceeded`,
      });
    }
  }

  const hint = levelIndex === 0 && total.inputTokens > highMark ? await compactionFor('proactive', 0) : undefined;
  const finalInput = assemble();
  const layerByItem = new Map<InputItem, TaggedItem['layer']>();
  layerByItem.set(task, 'history.user');
  for (const message of [...head.catalogMessages, ...skillMessages]) layerByItem.set(message, 'skills');
  for (const file of [discovered.user, discovered.root, ...nested]) if (file !== undefined) layerByItem.set(file.message, 'instructions');
  for (const message of head.governing) layerByItem.set(message, 'governing');
  if (memoryMessage !== undefined) layerByItem.set(memoryMessage, 'memories');
  for (const item of summaryItems) layerByItem.set(item, 'summary');
  for (const item of workingStateItems) layerByItem.set(item, 'workingState');
  for (const item of trailing) layerByItem.set(item, 'notices');
  layerByItem.set(systemMessage, 'system');
  const tagged = finalInput.map((item): TaggedItem => ({ item, layer: layerByItem.get(item) ?? historyLayerOf(item) }));
  const anatomy = await anatomyOf(meter, tools, tagged, total, (item) =>
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
    notices,
    loadedInstructions: [discovered.user, discovered.root, ...nested]
      .filter((file) => file !== undefined)
      .map((file) => file.instruction),
    loadedMemoryIds: memoryCandidates.slice(0, memoryCount).map((memory) => memory.id),
    loadedGoverning: loadedGoverningOf(sources.governing),
  };
};
