import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from '@opentelemetry/semantic-conventions/incubating';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

const NPM_VERSION = '1.43.0';

export const GENAI_SEMCONV = {
  npmVersion: NPM_VERSION,
  schemaUrl: `https://opentelemetry.io/schemas/${NPM_VERSION}`,
  attributes: {
    ATTR_GEN_AI_OPERATION_NAME,
    ATTR_GEN_AI_PROVIDER_NAME,
    ATTR_GEN_AI_REQUEST_MODEL,
    ATTR_GEN_AI_RESPONSE_MODEL,
    ATTR_GEN_AI_REQUEST_MAX_TOKENS,
    ATTR_GEN_AI_REQUEST_STREAM,
    ATTR_GEN_AI_RESPONSE_ID,
    ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
    ATTR_GEN_AI_USAGE_INPUT_TOKENS,
    ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
    ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
    ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
    ATTR_GEN_AI_AGENT_NAME,
    ATTR_GEN_AI_AGENT_ID,
    ATTR_GEN_AI_CONVERSATION_ID,
    ATTR_GEN_AI_TOOL_NAME,
    ATTR_GEN_AI_TOOL_CALL_ID,
    ATTR_GEN_AI_TOOL_TYPE,
    ATTR_ERROR_TYPE,
  },
} as const;

export const GENAI_CONTENT_SEMCONV = {
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
} as const;

export const MOMONGA_ATTRIBUTES = {
  runId: 'momonga.run_id',
  step: 'momonga.step',
  attempt: 'momonga.attempt',
  billing: 'momonga.billing',
  cacheWriteInputTokens: 'momonga.usage.cache_write_input_tokens',
  target: 'momonga.target',
  role: 'momonga.role',
  failureMessage: 'momonga.failure_message',
  fallbackCauses: 'momonga.fallback_causes',
} as const;

export const UNKNOWN_BILLING = 'unknown';

export const OPERATIONS = {
  agent: 'invoke_agent',
  chat: 'chat',
  tool: 'execute_tool',
} as const;

export const EXCEPTION_EVENT = {
  name: 'exception',
  type: 'exception.type',
  message: 'exception.message',
} as const;
