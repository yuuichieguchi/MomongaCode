import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape, marginFloorFor } from '@momonga/protocol';
import { postJson, readJson, readSse } from './gateway-helpers.ts';
import { lastCompletionBody, startFake } from './cc-support.ts';
import { ccAdapterFor, startCcGateway } from './cc-compact-support.ts';

const recordedStepOne = JSON.parse(fs.readFileSync(new URL('./fixtures/lmstudio/constrained-step1-request.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const LMSTUDIO_CONTEXT_WINDOW = 4096;
const LMSTUDIO_PROMPT_TOKENS = 992;

const lmStudioReply = {
  kind: 'stream' as const,
  chunks: [{ delta: { role: 'assistant', content: '{"kind":"final","text":"Done."}' }, finishReason: 'stop' }],
  usage: { prompt_tokens: LMSTUDIO_PROMPT_TOKENS, completion_tokens: 9, total_tokens: LMSTUDIO_PROMPT_TOKENS + 9 },
};

describe('the count of a constrained request against the prompt_tokens LM Studio reported for it', () => {
  it('stays within the truncation margin, because LM Studio leaves response_format out of prompt_tokens', async () => {
    const fake = await startFake({ scenario: 'json-schema-only', streamUsage: true, script: [lmStudioReply] });
    const harness = await startCcGateway({ lms: ccAdapterFor(fake, 'constrained', { contextWindow: LMSTUDIO_CONTEXT_WINDOW, maxOutputTokens: 1024 }) });

    const frames = await readSse(await postJson(harness.client, '/v1/responses', { model: 'lms/system', stream: true, store: false, ...recordedStepOne }));
    const completed = frames.at(-1)?.data;
    expect(completed?.type).toBe('response.completed');
    expect(lastCompletionBody(fake).response_format?.type).toBe('json_schema');
    const reported = completed?.response.usage.input_tokens as number;
    expect(reported).toBe(LMSTUDIO_PROMPT_TOKENS);

    const counted = (await readJson(await postJson(harness.client, '/v1/momonga/count_tokens', { model: 'lms/system', ...recordedStepOne }))).body.input_tokens as number;
    const margin = marginFloorFor(LMSTUDIO_CONTEXT_WINDOW) + errorBoundOfShape(ESTIMATED_ERROR_SHAPE, counted);

    expect(counted - reported).toBeLessThanOrEqual(margin);
  });
});
