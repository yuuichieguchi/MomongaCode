import { afterEach, describe, expect, it } from 'vitest';
import { vocabularyOf, runProbe } from '@momonga/gateway';
import { FM_CONTEXT_OVERFLOW_ERROR, startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';
import { FM_SERVER } from '@momonga/protocol';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';
import { hostProbePorts } from './probe-ports-support.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const FM_GUARDRAIL_EVENT = { error: { code: '500', message: "The model's safety guardrails were triggered.", type: 'server_error' } };
const FM_LARGEST_ACCEPTED_WORDS = 4041;
const FM_GUARDRAIL_BAND = { fromWords: 3328, toWords: 3880 };
const FM_WINDOW_SEEN_BY_COUNTER = FM_LARGEST_ACCEPTED_WORDS + 1 + 1;
const SEARCH_TOLERANCE = 0.01;

type ChatBody = { messages?: Array<{ content?: unknown }> };

const userTextOf = (body: unknown): string | undefined => {
  const content = (body as ChatBody).messages?.[0]?.content;
  return typeof content === 'string' ? content : undefined;
};

const wordCount = (text: string): number => text.split(/\s+/).filter((word) => word.length > 0).length;

const fmCountTokens = async (text: string): Promise<number> => wordCount(text) + 1;

const isRepeatedWordFiller = (text: string): boolean => /^word( word)*$/.test(text);

const overflowsFm = (body: unknown): boolean => {
  const text = userTextOf(body);
  return text !== undefined && wordCount(text) > FM_LARGEST_ACCEPTED_WORDS;
};

const tripsFmGuardrail = (body: unknown): boolean => {
  const text = userTextOf(body);
  if (text === undefined || !isRepeatedWordFiller(text)) return false;
  const words = wordCount(text);
  return words >= FM_GUARDRAIL_BAND.fromWords && words <= FM_GUARDRAIL_BAND.toWords;
};

describe('the fm context window search against the guardrail fm applies to a repeated-word prompt', () => {
  it('measures the window fm accepts instead of failing on the guardrail error event fm streams for a prompt below its window', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      wire: 'fm',
      contextWindow: 100_000,
      contextSizeExposure: 'none',
      routes: [
        { match: overflowsFm, reply: { kind: 'error-event', body: FM_CONTEXT_OVERFLOW_ERROR } },
        { match: tripsFmGuardrail, reply: { kind: 'error-event', body: FM_GUARDRAIL_EVENT } },
      ],
    });
    servers.push(fake);

    const report = await runProbe({
      ports: hostProbePorts,
      socketPath: fake.socketPath,
      managed: FM_PROBE_ROUTES,
      samples: 2,
      vocabulary: vocabularyOf(FM_SERVER),
      countTokens: fmCountTokens,
    });

    expect(report.contextWindow.method).toBe('searched');
    expect(report.contextWindow.value).toBeLessThanOrEqual(FM_WINDOW_SEEN_BY_COUNTER);
    expect(report.contextWindow.value).toBeGreaterThanOrEqual(Math.floor(FM_WINDOW_SEEN_BY_COUNTER * (1 - SEARCH_TOLERANCE)));
    expect(report.contextWindow.overflowErrorShape).toEqual(FM_CONTEXT_OVERFLOW_ERROR);
  });
});
