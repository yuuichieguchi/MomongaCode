import { findDanglingOutput } from '@momonga/protocol';
import type { FunctionCallOutputInputItem, InputItem, MessageInputItem } from '@momonga/protocol';
import { budgetFor } from './budget.ts';
import { chainTail, digestChain, frozenItem } from './digests.ts';
import { ContextOverflowError, PinnedOverflowError, PrefixChangedError } from './errors.ts';
import { discoverInstructions } from './instructions.ts';
import { headAndTail, omittedMarker, outputTextOf, truncatedMarker, withOutput } from './tool-output.ts';
import type {
  BuildContextInput,
  BuildContextPorts,
  BuiltContext,
  ContextEviction,
  ContextNotice,
  MeterCount,
} from './types.ts';

const DEFAULT_KEEP_RECENT_TURNS = 3;
const DEFAULT_COMPACT_AT = 0.7;
const ITEM_CAP_RATIO = 0.25;
const MIN_ITEM_CAP = 64;
const ASSUMED_HANDLE = 'x'.repeat(36);
const BLOB_MEDIA_TYPE = 'text/plain';

type OutputState = {
  original: FunctionCallOutputInputItem;
  callId: string;
  text: string;
  tokens: number;
  handle: string | undefined;
  mode: 'full' | 'truncated' | 'omitted';
  renderedTokens: number;
};

type Slot = {
  seq: number;
  turn: number;
  item: InputItem;
  output?: OutputState;
};

const isUserMessage = (item: InputItem): boolean => item.type === 'message' && item.role === 'user';

export const buildContext = async (input: BuildContextInput, ports: BuildContextPorts): Promise<BuiltContext> => {
  const { capabilities, sources, evicted } = input;
  const { meter, blobs } = ports;
  const tools = [...sources.tools];
  const compactAt = input.compactAt ?? DEFAULT_COMPACT_AT;
  const requestedKeep = input.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  if (!Number.isInteger(requestedKeep) || requestedKeep < 1) {
    throw new RangeError(`keepRecentTurns must be a positive integer, received ${requestedKeep}`);
  }

  const budgetOf = (counted: MeterCount) => budgetFor(capabilities, counted.errorBound);
  const fits = (counted: MeterCount): boolean => counted.inputTokens <= budgetOf(counted).I;
  const belowCompactLimit = (counted: MeterCount): boolean => counted.inputTokens <= compactAt * budgetOf(counted).I;
  const countInput = (items: readonly InputItem[]): Promise<MeterCount> => meter.count({ input: items, tools });

  const discovered = await discoverInstructions({
    reader: ports.instructions,
    home: input.home,
    projectRoot: input.projectRoot,
    trusted: input.trusted,
    touchedPaths: input.touchedPaths,
  });
  const notices: ContextNotice[] = [...discovered.notices];

  const systemMessage: MessageInputItem = { type: 'message', role: 'system', content: sources.systemPrompt };
  const pinned: InputItem[] = [
    systemMessage,
    ...[discovered.user, discovered.root].flatMap((file) => (file === undefined ? [] : [file.message])),
    frozenItem(sources.task),
  ];
  const pinnedDigest = chainTail(digestChain({ scope: 'pinned', tools }, pinned));
  if (input.expectedPinnedDigest !== undefined && input.expectedPinnedDigest !== pinnedDigest) {
    throw new PrefixChangedError(input.expectedPinnedDigest, pinnedDigest);
  }
  const pinnedCounted = await countInput(pinned);
  if (!fits(pinnedCounted)) throw new PinnedOverflowError(pinnedCounted.inputTokens, budgetOf(pinnedCounted).I);

  const nested = [...discovered.nested];
  const skillMessages: MessageInputItem[] = sources.activatedSkills.map((skill) => ({
    type: 'message',
    role: 'developer',
    content: `Activated skill ${skill.name}:\n${skill.content}`,
  }));
  const layersOf = (): InputItem[] => [...pinned, ...nested.map((file) => file.message), ...skillMessages];
  let layers = layersOf();
  let layersCounted = nested.length + skillMessages.length === 0 ? pinnedCounted : await countInput(layers);
  while (!fits(layersCounted) && nested.length > 0) {
    const dropped = nested.shift();
    if (dropped === undefined) break;
    notices.push({
      code: 'instructions_dropped',
      message: `${dropped.instruction.path} was dropped because the context budget was exceeded`,
    });
    layers = layersOf();
    layersCounted = await countInput(layers);
  }
  if (!fits(layersCounted)) throw new PinnedOverflowError(layersCounted.inputTokens, budgetOf(layersCounted).I);

  const summaryItems: InputItem[] = sources.summary === undefined ? [] : [frozenItem(sources.summary.item)];
  const prefixDigest = chainTail(digestChain({ scope: 'prefix', tools }, [...layers, ...summaryItems]));

  const itemCap = Math.max(MIN_ITEM_CAP, Math.floor(ITEM_CAP_RATIO * budgetFor(capabilities, 0).I));
  const reports = new Map<string, ContextEviction>();

  const ensureHandle = async (state: OutputState): Promise<boolean> => {
    if (state.handle !== undefined) return false;
    const stored = await blobs.put(state.text, { mediaType: BLOB_MEDIA_TYPE });
    state.handle = stored.handle;
    return true;
  };

  const truncate = async (state: OutputState, handle: string): Promise<InputItem> => {
    const marker = truncatedMarker(state.tokens, handle);
    let kept = Math.floor((state.text.length * itemCap) / state.tokens);
    for (;;) {
      const rendered = withOutput(state.original, headAndTail(state.text, kept, marker));
      const tokens = await meter.countItem(rendered);
      if (tokens <= itemCap || kept === 0) {
        state.renderedTokens = tokens;
        return rendered;
      }
      kept = Math.max(0, Math.min(kept - 1, Math.floor((kept * itemCap) / tokens)));
    }
  };

  const historyItems = (
    sources.summary === undefined
      ? sources.history
      : sources.history.filter((entry) => entry.seq > (sources.summary?.replacedThroughSeq ?? 0))
  ).map((entry) => ({
    seq: entry.seq,
    item: frozenItem(entry.item),
    ...(entry.handle === undefined ? {} : { handle: entry.handle }),
  }));

  if (sources.summary !== undefined) {
    const dangling = findDanglingOutput(historyItems);
    if (dangling !== undefined) {
      throw new RangeError(
        `summary boundary splits call ${dangling.callId}: output at seq ${dangling.seq} has no retained function_call`,
      );
    }
  }

  const slots: Slot[] = [];
  let turn = 0;
  for (const [index, entry] of historyItems.entries()) {
    if (index > 0 && isUserMessage(entry.item)) turn += 1;
    const slot: Slot = { seq: entry.seq, turn, item: entry.item };
    if (entry.item.type === 'function_call_output') {
      const original = entry.item;
      const text = outputTextOf(original.output);
      const tokens = await meter.countItem(original);
      const state: OutputState = {
        original,
        callId: original.call_id,
        text,
        tokens,
        handle: 'handle' in entry ? entry.handle : undefined,
        mode: 'full',
        renderedTokens: tokens,
      };
      slot.output = state;
      if (evicted.has(state.callId)) {
        const created = await ensureHandle(state);
        const handle = state.handle as string;
        slot.item = withOutput(original, omittedMarker(tokens, handle));
        state.mode = 'omitted';
        state.renderedTokens = await meter.countItem(slot.item);
        if (created) reports.set(state.callId, { callId: state.callId, handle, kind: 'omitted' });
      } else if (tokens > itemCap) {
        await ensureHandle(state);
        const handle = state.handle as string;
        slot.item = await truncate(state, handle);
        state.mode = 'truncated';
        reports.set(state.callId, { callId: state.callId, handle, kind: 'truncated' });
      }
    }
    slots.push(slot);
  }
  const turnCount = slots.length === 0 ? 0 : (slots.at(-1)?.turn ?? 0) + 1;

  const assemble = (): InputItem[] => [...layers, ...summaryItems, ...slots.map((slot) => slot.item)];

  const evictOldest = async (keep: number): Promise<boolean> => {
    for (const slot of slots) {
      const state = slot.output;
      if (state === undefined || state.mode === 'omitted' || slot.turn >= turnCount - keep) continue;
      const probe = withOutput(state.original, omittedMarker(state.tokens, state.handle ?? ASSUMED_HANDLE));
      if ((await meter.countItem(probe)) >= state.renderedTokens) continue;
      await ensureHandle(state);
      const handle = state.handle as string;
      slot.item = withOutput(state.original, omittedMarker(state.tokens, handle));
      state.mode = 'omitted';
      state.renderedTokens = await meter.countItem(slot.item);
      reports.set(state.callId, { callId: state.callId, handle, kind: 'omitted' });
      return true;
    }
    return false;
  };

  const compactThroughSeqFor = (keep: number): number | undefined => {
    const lastCompactableTurn = turnCount - keep - 1;
    if (lastCompactableTurn < 0) return undefined;
    return slots.findLast((slot) => slot.turn === lastCompactableTurn)?.seq;
  };

  let keep = requestedKeep;
  let total = await countInput(assemble());
  for (;;) {
    while (!belowCompactLimit(total) && (await evictOldest(keep))) total = await countInput(assemble());
    if (fits(total)) break;
    if (keep > 1 && turnCount > 1) {
      keep = 1;
      notices.push({
        code: 'recent_turns_shrunk',
        message: 'recent turns were reduced to the current turn because the context budget was exceeded',
      });
      continue;
    }
    throw new ContextOverflowError(total.inputTokens, budgetOf(total).I, compactThroughSeqFor(keep));
  }

  const compactThroughSeq = belowCompactLimit(total) ? undefined : compactThroughSeqFor(keep);
  return {
    input: assemble(),
    tools,
    maxOutputTokens: budgetOf(total).R,
    inputTokens: total.inputTokens,
    budget: budgetOf(total),
    prefixDigest,
    pinnedDigest,
    inputDigest: total.inputDigest,
    evictions: [...reports.values()],
    needsCompaction: compactThroughSeq !== undefined,
    ...(compactThroughSeq === undefined ? {} : { compactThroughSeq }),
    notices,
    loadedInstructions: [discovered.user, discovered.root, ...nested]
      .filter((file) => file !== undefined)
      .map((file) => file.instruction),
  };
};
