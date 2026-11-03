import { reasoningEffortToSend } from '@momonga/protocol';
import type { AdapterRequest, Capabilities } from '@momonga/protocol';
import type { ChatRequestBody } from './native-request.ts';

const reasoningOptions = (body: ChatRequestBody, request: AdapterRequest, capabilities: Capabilities): Partial<ChatRequestBody> => {
  const requested = request.reasoning_effort;
  if (requested === undefined) return {};
  const { reasoning } = capabilities;
  if (reasoning?.control === 'reasoning_effort') return { reasoning_effort: reasoningEffortToSend(requested, reasoning.lowest) };
  const headroom = reasoning?.headroomTokens ?? 0;
  if (headroom === 0 || body.max_tokens === undefined) return {};
  return { max_tokens: Math.min(body.max_tokens + headroom, capabilities.maxOutputTokens) };
};

export const withCapabilityOptions = (body: ChatRequestBody, request: AdapterRequest, capabilities: Capabilities): ChatRequestBody => {
  const hasNativeTools = body.tools !== undefined;
  const forbidParallel = hasNativeTools && (!capabilities.parallelToolCalls || request.parallel_tool_calls === false);
  return { ...body, ...(forbidParallel ? { parallel_tool_calls: false } : {}), ...reasoningOptions(body, request, capabilities) };
};
