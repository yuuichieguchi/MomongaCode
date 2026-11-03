import { canonicalJson } from '@momonga/foundation';
import type { CountTokensRequest, CountTokensResult, FunctionTool, InputItem } from '@momonga/protocol';
import { digestChain, itemDigest } from './digests.ts';
import type { ItemCountContext, MeterCount, MeterRequest, TokenMeter, TokenMeterOptions, UsageObservation } from './types.ts';

const ERROR_WINDOW = 20;
const ESTIMATED_ERROR_FLOOR = 0.1;
const MAX_RELATIVE_ERROR = 1;
const MAX_COUNTED = 1024;
const MAX_OBSERVATIONS = 64;
const MAX_ITEM_COUNTS = 8192;

type CountedRecord = { itemCount: number; inputTokens: number; counterBound: number; estimatedTokens: number };

const estimatedPartOf = (result: CountTokensResult): number => (result.method === 'estimated' ? result.input_tokens : 0);

const remember = <V>(map: Map<string, V>, key: string, value: V, limit: number): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
};

export const createTokenMeter = ({ counter, model, capabilities }: TokenMeterOptions): TokenMeter => {
  const counted = new Map<string, CountedRecord>();
  const observations = new Map<string, CountedRecord>();
  const itemTokens = new Map<string, number>();
  const baselines = new Map<string, number>();
  const errors: number[] = [];

  const relativeError = (): number => {
    const observed = errors.length > 0 ? Math.max(...errors) : 0;
    return capabilities.tokenCounting === 'estimated' ? Math.max(ESTIMATED_ERROR_FLOOR, observed) : observed;
  };

  const errorBoundOf = (record: CountedRecord): number => {
    const relativeBound = Math.ceil(relativeError() * record.inputTokens);
    return capabilities.tokenCounting === 'estimated'
      ? Math.max(relativeBound, record.counterBound)
      : relativeBound + record.counterBound;
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

  const baselineOf = async (tools: readonly FunctionTool[], instructions: string | undefined): Promise<number> => {
    if (tools.length === 0 && instructions === undefined) return 0;
    const key = canonicalJson({ instructions: instructions ?? null, tools });
    const known = baselines.get(key);
    if (known !== undefined) return known;
    const result = await counter.count(requestOf([], tools, instructions));
    baselines.set(key, result.input_tokens);
    return result.input_tokens;
  };

  const count = async ({ input, tools, instructions }: MeterRequest): Promise<MeterCount> => {
    const chain = digestChain({ instructions: instructions ?? null, tools }, input);
    const digestAt = (length: number): string => chain[length] as string;
    const inputDigest = digestAt(input.length);
    const withBound = (record: CountedRecord): MeterCount => ({
      inputTokens: record.inputTokens,
      inputDigest,
      errorBound: errorBoundOf(record),
      estimatedTokens: Math.min(record.estimatedTokens, record.inputTokens),
    });

    const known = counted.get(inputDigest);
    if (known !== undefined) return withBound(known);

    const lengths = [...new Set([...observations.values()].map((entry) => entry.itemCount))]
      .filter((length) => length <= input.length)
      .sort((a, b) => b - a);
    let record: CountedRecord | undefined;
    for (const length of lengths) {
      const observation = observations.get(digestAt(length));
      if (observation === undefined) continue;
      if (length === input.length) {
        record = observation;
      } else {
        const suffix = await counter.count(requestOf(input.slice(length), tools, instructions));
        const baseline = await baselineOf(tools, instructions);
        record = {
          itemCount: input.length,
          inputTokens: observation.inputTokens + suffix.input_tokens - baseline,
          counterBound: suffix.error_bound,
          estimatedTokens: observation.estimatedTokens + estimatedPartOf(suffix),
        };
      }
      break;
    }
    if (record === undefined) {
      const result = await counter.count(requestOf(input, tools, instructions));
      record = { itemCount: input.length, inputTokens: result.input_tokens, counterBound: result.error_bound, estimatedTokens: estimatedPartOf(result) };
    }
    remember(counted, inputDigest, record, MAX_COUNTED);
    return withBound(record);
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

  const observe = ({ inputDigest, inputTokens }: UsageObservation): void => {
    const record = counted.get(inputDigest);
    if (record === undefined) throw new Error(`token meter has no count for input digest ${inputDigest}`);
    const estimate = record.inputTokens;
    const underEstimate = Math.max(0, inputTokens - estimate) / Math.max(estimate, 1);
    errors.push(Math.min(underEstimate, MAX_RELATIVE_ERROR));
    if (errors.length > ERROR_WINDOW) errors.shift();
    const conservative = Math.max(estimate, inputTokens);
    const kept = { ...record, inputTokens: conservative, estimatedTokens: inputTokens >= estimate ? 0 : record.estimatedTokens };
    remember(counted, inputDigest, kept, MAX_COUNTED);
    remember(observations, inputDigest, kept, MAX_OBSERVATIONS);
  };

  return { count, countItem, observe, relativeError };
};
