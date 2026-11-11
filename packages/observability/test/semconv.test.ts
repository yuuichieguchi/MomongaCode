import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import * as incubating from '@opentelemetry/semantic-conventions/incubating';
import { GENAI_CONTENT_SEMCONV, GENAI_SEMCONV } from '@momonga/observability';

const EXPECTED_KEYS = {
  ATTR_GEN_AI_OPERATION_NAME: 'gen_ai.operation.name',
  ATTR_GEN_AI_PROVIDER_NAME: 'gen_ai.provider.name',
  ATTR_GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
  ATTR_GEN_AI_RESPONSE_MODEL: 'gen_ai.response.model',
  ATTR_GEN_AI_REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  ATTR_GEN_AI_REQUEST_STREAM: 'gen_ai.request.stream',
  ATTR_GEN_AI_RESPONSE_ID: 'gen_ai.response.id',
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  ATTR_GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS: 'gen_ai.usage.reasoning.output_tokens',
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK: 'gen_ai.response.time_to_first_chunk',
  ATTR_GEN_AI_AGENT_NAME: 'gen_ai.agent.name',
  ATTR_GEN_AI_AGENT_ID: 'gen_ai.agent.id',
  ATTR_GEN_AI_CONVERSATION_ID: 'gen_ai.conversation.id',
  ATTR_GEN_AI_TOOL_NAME: 'gen_ai.tool.name',
  ATTR_GEN_AI_TOOL_CALL_ID: 'gen_ai.tool.call.id',
  ATTR_GEN_AI_TOOL_TYPE: 'gen_ai.tool.type',
} as const;

const installedSemconvVersion = (): string => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@opentelemetry/semantic-conventions');
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json')) || !dir.endsWith('semantic-conventions')) dir = path.dirname(dir);
  return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
};

describe('GENAI_SEMCONV', () => {
  it('pins the semconv npm version that is actually installed', () => {
    expect(GENAI_SEMCONV.npmVersion).toBe('1.44.0');
    expect(installedSemconvVersion()).toBe(GENAI_SEMCONV.npmVersion);
  });

  it('carries the schema url of the pinned version', () => {
    expect(GENAI_SEMCONV.schemaUrl).toBe(`https://opentelemetry.io/schemas/${GENAI_SEMCONV.npmVersion}`);
  });

  it('exposes exactly the GenAI keys we use, each equal to the incubating export and the literal string', () => {
    const exported = incubating as unknown as Record<string, unknown>;
    const attributes = GENAI_SEMCONV.attributes as Record<string, string>;
    expect(Object.keys(attributes).sort()).toEqual([...Object.keys(EXPECTED_KEYS), 'ATTR_ERROR_TYPE'].sort());
    for (const [name, literal] of Object.entries(EXPECTED_KEYS)) {
      expect(exported[name], name).toBe(literal);
      expect(attributes[name], name).toBe(literal);
    }
    expect(ATTR_ERROR_TYPE).toBe('error.type');
    expect(attributes['ATTR_ERROR_TYPE']).toBe('error.type');
  });
});

describe('GENAI_CONTENT_SEMCONV', () => {
  it('exposes exactly the opt-in content keys of the pinned version, each equal to the incubating export and the literal string', () => {
    const expected = {
      ATTR_GEN_AI_SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
      ATTR_GEN_AI_INPUT_MESSAGES: 'gen_ai.input.messages',
      ATTR_GEN_AI_OUTPUT_MESSAGES: 'gen_ai.output.messages',
      ATTR_GEN_AI_TOOL_DEFINITIONS: 'gen_ai.tool.definitions',
      ATTR_GEN_AI_TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
      ATTR_GEN_AI_TOOL_CALL_RESULT: 'gen_ai.tool.call.result',
    };
    const exported = incubating as unknown as Record<string, unknown>;
    expect(GENAI_CONTENT_SEMCONV).toEqual(expected);
    for (const [name, literal] of Object.entries(expected)) expect(exported[name], name).toBe(literal);
  });
});
