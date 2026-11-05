import { DEFAULT_OUTPUT_BOUND_FIELD, acceptedReasoningEfforts, clampReasoningEffort, outputTokensFor } from '@momonga/protocol';
import type { AdapterRequest, Capabilities } from '@momonga/protocol';
import type { ChatRequestBody } from './native-request.ts';
import { outputBoundFor } from './output-bound.ts';

const reasoningEffortOption = (request: AdapterRequest, capabilities: Capabilities): Partial<ChatRequestBody> => {
  const requested = request.reasoning_effort;
  const { reasoning } = capabilities;
  if (requested === undefined || reasoning?.control !== 'reasoning_effort') return {};
  return { reasoning_effort: clampReasoningEffort(requested, acceptedReasoningEfforts(reasoning)) };
};

const outputBoundTokens = (request: AdapterRequest, capabilities: Capabilities): number | undefined => {
  const requested = request.max_output_tokens;
  if (requested === undefined || requested === null) return undefined;
  return Math.min(outputTokensFor(capabilities, request.reasoning_effort, requested), Math.max(requested, capabilities.maxOutputTokens));
};

const outputBoundOption = (request: AdapterRequest, capabilities: Capabilities): Partial<ChatRequestBody> => {
  const tokens = outputBoundTokens(request, capabilities);
  return tokens === undefined ? {} : outputBoundFor(capabilities.outputBoundField ?? DEFAULT_OUTPUT_BOUND_FIELD, tokens);
};

export const withCapabilityOptions = (body: ChatRequestBody, request: AdapterRequest, capabilities: Capabilities): ChatRequestBody => {
  const hasNativeTools = body.tools !== undefined;
  const forbidParallel = hasNativeTools && (capabilities.parallelToolCalls === false || request.parallel_tool_calls === false);
  const sendKey = capabilities.promptCache?.kind === 'key' && request.promptCacheKey !== undefined;
  return {
    ...body,
    ...(forbidParallel ? { parallel_tool_calls: false } : {}),
    ...reasoningEffortOption(request, capabilities),
    ...outputBoundOption(request, capabilities),
    ...(sendKey ? { prompt_cache_key: request.promptCacheKey } : {}),
  };
};
