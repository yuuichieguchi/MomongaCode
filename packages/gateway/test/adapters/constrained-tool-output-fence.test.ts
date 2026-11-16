import { describe, expect, it } from 'vitest';
import { FENCE_BOUNDARY_MARKER, TOOL_OUTPUT_TAG, fenceUntrusted } from '@momonga/protocol';
import type { AdapterInputItem, AdapterRequest, FunctionTool } from '@momonga/protocol';
import { buildConstrainedBody } from '../../src/adapters/chat-completions/constrained-request.ts';
import { summaryRequestOf } from '../../src/adapters/shared/compact.ts';
import { FULL_KEYWORD_SUPPORT } from '../../src/dialect/keyword-support.ts';
import { EVERY_REASONING_IS_OWN } from '../own-reasoning.ts';

const FENCE = 'f3a9c1d27b4e48e6a0c5d9b812e7f604';
const OUTPUT = 'line one\nline two';
const TOOLS: FunctionTool[] = [{ type: 'function', name: 'Grep', parameters: { type: 'object' } }];

const historyWith = (output: string): AdapterInputItem[] => [
  { type: 'message', role: 'user', content: 'search' },
  { type: 'function_call', call_id: 'call_1', name: 'Grep', arguments: '{"pattern":"x"}' },
  { type: 'function_call_output', call_id: 'call_1', output },
];

const bodyOf = (output: string) => {
  const request: AdapterRequest = { model: 'm', input: historyWith(output), tools: TOOLS, fence: FENCE };
  return buildConstrainedBody(request, FULL_KEYWORD_SUPPORT, EVERY_REASONING_IS_OWN, 'json-schema-2020-12').body;
};

const toolStepOf = (body: ReturnType<typeof bodyOf>): string => {
  const step = body.messages.filter((message) => message['role'] === 'user').map((message) => String(message['content'])).find((content) => content.includes(`<${TOOL_OUTPUT_TAG}`));
  if (step === undefined) throw new Error('the body holds no tool step');
  return step;
};

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('the constrained body fences a tool step once, with the real boundary', () => {
  const runtimeFenced = fenceUntrusted(TOOL_OUTPUT_TAG, { call: 'call_1', tool: 'Grep' }, OUTPUT, FENCE);

  it('an output the runtime already fenced is sent with exactly one fence', () => {
    const step = toolStepOf(bodyOf(runtimeFenced));
    expect(occurrences(step, `<${TOOL_OUTPUT_TAG} `)).toBe(1);
    expect(occurrences(step, `</${TOOL_OUTPUT_TAG} `)).toBe(1);
    expect(occurrences(step, FENCE)).toBe(2);
    expect(step).not.toContain(FENCE_BOUNDARY_MARKER);
    expect(step).toContain(runtimeFenced);
  });

  it('an output that reached the gateway unfenced is fenced once, the same way', () => {
    expect(toolStepOf(bodyOf(OUTPUT))).toBe(toolStepOf(bodyOf(runtimeFenced)));
  });

  it('the wire body of the runtime-fenced step counts what a single fence counts', () => {
    expect(JSON.stringify(bodyOf(runtimeFenced))).toBe(JSON.stringify(bodyOf(OUTPUT)));
  });
});

describe('the compaction transcript fences a tool step once, with the real boundary', () => {
  const runtimeFenced = fenceUntrusted(TOOL_OUTPUT_TAG, { call: 'call_1', tool: 'Grep' }, OUTPUT, FENCE);
  const transcriptOf = (output: string): string =>
    JSON.stringify(summaryRequestOf({ model: 'm', input: historyWith(output), momonga: { fence: FENCE } }, 2000, EVERY_REASONING_IS_OWN).input);

  it('an output the runtime already fenced is in the transcript with exactly one fence', () => {
    const transcript = transcriptOf(runtimeFenced);
    expect(occurrences(transcript, `<${TOOL_OUTPUT_TAG} `)).toBe(1);
    expect(transcript).not.toContain(FENCE_BOUNDARY_MARKER);
    expect(transcript).toContain(JSON.stringify(runtimeFenced).slice(1, -1));
  });

  it('an unfenced output is fenced the same way', () => {
    expect(transcriptOf(OUTPUT)).toBe(transcriptOf(runtimeFenced));
  });
});
