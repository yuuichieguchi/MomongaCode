import { canonicalJson } from '@momonga/foundation';
import { ceilRatio, marginFloorFor, quantizedRatioOf, errorBoundOfShape } from '@momonga/protocol';
import type { CountTokensMethod, CountTokensRequest, ErrorShape, FunctionTool, InputItem } from '@momonga/protocol';
import { digestChain, itemDigest } from './digests.ts';
import type {
  ItemCountContext,
  MeterCount,
  MeterMemory,
  MeterMiss,
  MeterObservation,
  MeterRequest,
  TokenMeter,
  TokenMeterOptions,
  UsageObservation,
} from './types.ts';

export const ERROR_WINDOW = 20;
const MAX_COUNTED = 1024;
const MAX_REPLIES = 4096;
const MAX_ITEM_COUNTS = 8192;

type Reply = { tokens: number; method: CountTokensMethod; shape: ErrorShape };

type Sigma = (tokens: number) => number;

type Decomposition = {
  inputTokens: number;
  known: number;
  uncounted: number;
  overCount: number;
  restA: number;
  fixedA: number;
  restB: number;
  sigmaB: Sigma;
};

type FrozenChoice = { epoch: number; split: boolean; underAt: ((tokens: number) => number) | undefined };

type Counted = {
  epoch: number;
  frozenKey: string | undefined;
  decomposition: Decomposition;
  input: readonly InputItem[];
  tools: readonly FunctionTool[];
  instructions: string | undefined;
  chain: readonly string[];
  view: MeterCount;
};

type Latest = {
  input: readonly InputItem[];
  tools: readonly FunctionTool[];
  instructions: string | undefined;
  chain: readonly string[];
  inputDigest: string;
  itemCount: number;
  reported: number;
  kept: number;
};

const remember = <V>(map: Map<string, V>, key: string, value: V, limit: number): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
};

const noSigma: Sigma = () => 0;

const nothingCounted = (inputTokens: number, known: number, uncounted: number): Decomposition => ({
  inputTokens,
  known,
  uncounted,
  overCount: 0,
  restA: 0,
  fixedA: 0,
  restB: 0,
  sigmaB: noSigma,
});

const markUnclosed = (items: readonly InputItem[], unclosed: boolean[]): void => {
  const firstCall = new Map<string, number>();
  const lastOutput = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.type === 'function_call' && !firstCall.has(item.call_id)) firstCall.set(item.call_id, index);
    if (item.type === 'function_call_output') lastOutput.set(item.call_id, index);
  });
  for (const [callId, call] of firstCall) {
    const output = lastOutput.get(callId);
    if (output === undefined) continue;
    for (let position = call + 1; position <= output; position += 1) unclosed[position] = true;
  }
};

export const callClosedBoundary = (a: readonly InputItem[], b: readonly InputItem[], commonPrefix: number): number => {
  const unclosed: boolean[] = [];
  markUnclosed(a, unclosed);
  markUnclosed(b, unclosed);
  let position = commonPrefix;
  while (position > 0 && unclosed[position] === true) position -= 1;
  return position;
};

const ceilQuotient = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

export const createTokenMeter = ({ counter, model, capabilities, observedCapacity = false }: TokenMeterOptions): TokenMeter => {
  const replies = new Map<string, Reply>();
  const counted = new Map<string, Counted>();
  const frozenChoices = new Map<string, FrozenChoice>();
  const itemTokens = new Map<string, number>();
  const baselines = new Map<string, number>();
  let misses: readonly MeterMiss[] = [];
  let latest: Latest | undefined;
  let epoch = 0;
  const marginFloor = BigInt(marginFloorFor(capabilities.contextWindow));
  const configuredRatio = capabilities.tokenErrorRatio === undefined ? undefined : quantizedRatioOf(capabilities.tokenErrorRatio);

  const sigmaOf = (reply: Reply): Sigma => {
    if (configuredRatio !== undefined && reply.method === capabilities.tokenCounting) {
      return (tokens) => (tokens <= 0 ? 0 : Math.max(reply.shape.minimum, ceilRatio(configuredRatio, tokens)));
    }
    return (tokens) => (tokens <= 0 ? 0 : errorBoundOfShape(reply.shape, tokens));
  };

  const excessAt = (window: readonly MeterMiss[]) => (size: number): number => {
    const bigSize = BigInt(size);
    let best = 0n;
    for (const { miss, uncounted } of window) {
      const scaled = uncounted >= 1 && size > uncounted ? ceilQuotient(BigInt(miss) * bigSize, BigInt(uncounted)) : BigInt(miss);
      if (scaled - marginFloor > best) best = scaled - marginFloor;
    }
    if (best > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`the observed excess ${best} is beyond the exact range of a number`);
    return Number(best);
  };

  const requestOf = (
    input: readonly InputItem[],
    tools: readonly FunctionTool[],
    instructions: string | undefined,
  ): CountTokensRequest => ({
    model,
    input: [...input],
    ...(tools.length > 0 ? { tools: [...tools] } : {}),
    ...(instructions === undefined ? {} : { instructions }),
  });

  const replyFor = async (key: string, request: CountTokensRequest): Promise<Reply> => {
    const known = replies.get(key);
    if (known !== undefined) return known;
    const result = await counter.count(request);
    const reply = { tokens: result.input_tokens, method: result.method, shape: result.error_shape };
    remember(replies, key, reply, MAX_REPLIES);
    return reply;
  };

  const baselineOf = async (tools: readonly FunctionTool[], instructions: string | undefined): Promise<number> => {
    if (tools.length === 0 && instructions === undefined) return 0;
    const key = canonicalJson({ instructions: instructions ?? null, tools });
    const known = baselines.get(key);
    if (known !== undefined) return known;
    const result = await counter.count(requestOf([], tools, instructions));
    baselines.set(key, result.input_tokens);
    return result.input_tokens;
  };

  const suffixOf = async (
    items: readonly InputItem[],
    chain: readonly string[],
    from: number,
    tools: readonly FunctionTool[],
    instructions: string | undefined,
  ): Promise<Reply> => {
    const reply = await replyFor(`suffix:${chain[0]}:${chain[from]}:${chain[items.length]}`, requestOf(items.slice(from), tools, instructions));
    return { ...reply, tokens: reply.tokens - (await baselineOf(tools, instructions)) };
  };

  const splitOf = async (
    chain: readonly string[],
    input: readonly InputItem[],
    tools: readonly FunctionTool[],
    instructions: string | undefined,
    fresh: Reply,
  ): Promise<Decomposition | undefined> => {
    if (latest === undefined || latest.chain[0] !== chain[0]) return undefined;
    let shared = 0;
    while (shared < input.length && shared < latest.itemCount && latest.chain[shared + 1] === chain[shared + 1]) shared += 1;
    shared = callClosedBoundary(latest.input, input, shared);
    const dropped = shared === latest.itemCount ? undefined : await suffixOf(latest.input, latest.chain, shared, tools, instructions);
    const added = shared === input.length ? undefined : await suffixOf(input, chain, shared, tools, instructions);
    const restA = dropped?.tokens ?? 0;
    const restB = added?.tokens ?? 0;
    const known = latest.kept - restA;
    if (known < 0) return undefined;
    return {
      inputTokens: known + restB,
      known,
      uncounted: restA + restB,
      overCount: latest.kept - latest.reported,
      restA,
      fixedA: dropped === undefined ? 0 : sigmaOf(dropped)(restA),
      restB,
      sigmaB: sigmaOf(added ?? fresh),
    };
  };

  const underOf = (decomposition: Decomposition, window: readonly MeterMiss[]): ((tokens: number) => number) => {
    const excess = excessAt(window);
    return (tokens) => {
      const added = Math.max(0, tokens - decomposition.known);
      return decomposition.fixedA + decomposition.sigmaB(added) + excess(decomposition.restA + added);
    };
  };

  const viewOf = (inputDigest: string, chosen: Decomposition, freshUnderAt: (tokens: number) => number, underAt: (tokens: number) => number): MeterCount => ({
    inputTokens: chosen.inputTokens,
    inputDigest,
    known: chosen.known,
    uncounted: chosen.uncounted,
    overTolerance: chosen.overCount + chosen.fixedA + chosen.sigmaB(chosen.restB),
    underAt,
    freshUnderAt,
  });

  const candidatesOf = async (
    chain: readonly string[],
    input: readonly InputItem[],
    tools: readonly FunctionTool[],
    instructions: string | undefined,
  ) => {
    const inputDigest = chain[input.length] as string;
    const fresh = await replyFor(`fresh:${inputDigest}`, requestOf(input, tools, instructions));
    const freshDecomposition: Decomposition = { ...nothingCounted(fresh.tokens, 0, fresh.tokens), restB: fresh.tokens, sigmaB: sigmaOf(fresh) };
    const window = misses;
    const freshUnderAt = underOf(freshDecomposition, window);
    const split = await splitOf(chain, input, tools, instructions, fresh);
    const splitUnderAt = split === undefined ? undefined : underOf(split, window);
    const splitWins =
      split !== undefined &&
      splitUnderAt !== undefined &&
      split.inputTokens + splitUnderAt(split.inputTokens) <= fresh.tokens + freshUnderAt(fresh.tokens);
    return { inputDigest, freshDecomposition, freshUnderAt, split, splitUnderAt, splitWins };
  };

  const frozenChoiceOf = async ({ frozen, tools, instructions }: MeterRequest & { frozen: readonly InputItem[] }): Promise<{ key: string; choice: FrozenChoice }> => {
    const chain = digestChain({ instructions: instructions ?? null, tools }, frozen);
    const key = `${chain[0]}:${chain[frozen.length]}`;
    if (latest === undefined || latest.chain[0] !== chain[0]) return { key, choice: { epoch, split: false, underAt: undefined } };
    const known = frozenChoices.get(key);
    if (known !== undefined && known.epoch === epoch) return { key, choice: known };
    const candidates = await candidatesOf(chain, frozen, tools, instructions);
    const choice: FrozenChoice = {
      epoch,
      split: candidates.splitWins,
      underAt: candidates.splitWins && candidates.splitUnderAt !== undefined ? candidates.splitUnderAt : candidates.freshUnderAt,
    };
    remember(frozenChoices, key, choice, MAX_COUNTED);
    return { key, choice };
  };

  const count = async (request: MeterRequest): Promise<MeterCount> => {
    const { input, tools, instructions, frozen, sent } = request;
    const chain = digestChain({ instructions: instructions ?? null, tools }, input);
    const inputDigest = chain[input.length] as string;
    const frozenResolved = frozen === undefined ? undefined : await frozenChoiceOf({ ...request, frozen });
    const frozenKey = frozenResolved?.key;
    const known = frozen === undefined || sent === true ? counted.get(inputDigest) : undefined;
    if (known !== undefined && known.epoch === epoch && (frozenKey === undefined || known.frozenKey === frozenKey)) return known.view;

    const { freshDecomposition, freshUnderAt, split, splitUnderAt, splitWins } = await candidatesOf(chain, input, tools, instructions);
    const useSplit = split !== undefined && splitUnderAt !== undefined && (frozenResolved === undefined ? splitWins : frozenResolved.choice.split);
    const chosen = useSplit ? split : freshDecomposition;
    const ownUnderAt = useSplit ? splitUnderAt : freshUnderAt;
    const underAt = frozenResolved === undefined || sent === true ? ownUnderAt : (frozenResolved.choice.underAt ?? ownUnderAt);
    const view = viewOf(inputDigest, chosen, freshUnderAt, underAt);
    if (frozen === undefined || sent === true) {
      remember(counted, inputDigest, { epoch, frozenKey, decomposition: chosen, input, tools, instructions, chain, view }, MAX_COUNTED);
    }
    return view;
  };

  const countItem = async (item: InputItem, { callNames, withTools }: ItemCountContext): Promise<number> => {
    const key = canonicalJson([itemDigest(item), withTools, callNames]);
    const known = itemTokens.get(key);
    if (known !== undefined) return known;
    const result = await counter.count({
      model,
      input: [item],
      momonga: { lenient_items: { call_names: { ...callNames }, with_tools: withTools } },
    });
    remember(itemTokens, key, result.input_tokens, MAX_ITEM_COUNTS);
    return result.input_tokens;
  };

  const observe = ({ inputDigest, inputTokens }: UsageObservation): MeterObservation => {
    const record = counted.get(inputDigest);
    if (record === undefined) throw new Error(`token meter has no count for input digest ${inputDigest}`);
    const { decomposition } = record;
    const reported = inputTokens;
    const kept = observedCapacity ? reported : Math.max(decomposition.inputTokens, reported);
    const miss = Math.max(0, reported - (decomposition.inputTokens - decomposition.overCount) - decomposition.fixedA - decomposition.sigmaB(decomposition.restB));
    latest = {
      input: record.input,
      tools: record.tools,
      instructions: record.instructions,
      chain: record.chain,
      inputDigest,
      itemCount: record.input.length,
      reported,
      kept,
    };
    misses = [...misses, { miss, uncounted: decomposition.uncounted }].slice(-ERROR_WINDOW);
    epoch += 1;
    return {
      inputDigest,
      itemCount: record.input.length,
      counted: decomposition.inputTokens,
      reported,
      kept,
      known: decomposition.known,
      uncounted: decomposition.uncounted,
      miss,
      contextWindow: capabilities.contextWindow,
      ...(capabilities.tokenErrorRatio === undefined ? {} : { tokenErrorRatio: capabilities.tokenErrorRatio }),
      tokenCounting: capabilities.tokenCounting,
    };
  };

  const restore = ({ latest: report, misses: window }: MeterMemory): void => {
    counted.clear();
    misses = [...window].slice(-ERROR_WINDOW);
    latest =
      report === undefined
        ? undefined
        : {
            input: report.input,
            tools: report.tools,
            instructions: undefined,
            chain: digestChain({ instructions: null, tools: report.tools }, report.input),
            inputDigest: report.observation.inputDigest,
            itemCount: report.observation.itemCount,
            reported: report.observation.reported,
            kept: observedCapacity ? report.observation.reported : report.observation.kept,
          };
    epoch += 1;
  };

  return { count, countItem, observe, restore };
};
