import { keyAuthSource, unauthenticatedSource } from '@momonga/gateway';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import { ESTIMATED_CHARACTERS_PER_TOKEN, MAX_COMPACTION_GUIDELINE_CHARS, MIN_SUMMARY_TOKENS, SUMMARY_PROMPT_TOKENS } from '@momonga/protocol';
import type { AdapterCompactRequest, AdapterTarget } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { summaryRequestOf } from '../src/adapters/shared/compact.ts';
import { createRequestValidator } from '../src/core/validation.ts';
import { TARGET, startFake, userText } from './cc-support.ts';
import { ccAdapterFor, estimatedTokens, KEEP_CLAUSE, RESTATE_CLAUSE } from './cc-compact-support.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const GUIDELINE = 'Keep every failing test name in DONE.';
const SECTIONS = ['GOAL:', 'STATE:', 'DONE:', 'TODO:', 'DECISIONS:', 'GUARDRAILS:'];

const compactRequest = (momonga: AdapterCompactRequest['momonga'] = {}): AdapterCompactRequest => ({
  model: 'system',
  input: [userText('Fix the parser')],
  momonga,
});

const instructionsOf = (request: AdapterCompactRequest, cap = 512): string => summaryRequestOf(request, cap, EVERY_REASONING_IS_OWN).instructions ?? '';

describe('the compaction prompt', () => {
  it('names the six sections in order', () => {
    const text = instructionsOf(compactRequest());
    const positions = SECTIONS.map((section) => text.indexOf(section));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('forbids invention and asks for verbatim identifiers', () => {
    const text = instructionsOf(compactRequest());
    expect(text).toMatch(/never invent/i);
    expect(text).toMatch(/identifiers verbatim/i);
  });

  it('asks for every path, command and test name in backticks', () => {
    expect(instructionsOf(compactRequest())).toMatch(/every path, command and test name in backticks/i);
  });

  it('keeps the cap and the request clause', () => {
    const text = instructionsOf(compactRequest({ retains_user_request: true }), 777);
    expect(text).toContain('777 tokens');
    expect(text).toContain(KEEP_CLAUSE);
  });

  it('appends a guideline after the fixed rules and omits it when absent', () => {
    const fixed = instructionsOf(compactRequest());
    const guided = instructionsOf(compactRequest({ guideline: GUIDELINE }));
    expect(fixed).not.toContain(GUIDELINE);
    expect(guided.startsWith(fixed)).toBe(true);
    expect(guided.endsWith(GUIDELINE)).toBe(true);
  });

  it('keeps the guideline ahead of the agent context', () => {
    const text = instructionsOf({ ...compactRequest({ guideline: GUIDELINE }), instructions: 'AGENT TEXT' });
    expect(text.indexOf(GUIDELINE)).toBeGreaterThan(-1);
    expect(text.indexOf(GUIDELINE)).toBeLessThan(text.indexOf('AGENT TEXT'));
  });
});

describe('every adapter renders the same prompt', () => {
  const target: AdapterTarget = TARGET;
  const shared = {
    resolveEndpoint: async () => ({ kind: 'unix' as const, socketPath: '/nonexistent' }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(0),
    liveness: UNDICI_DEFAULT_LIVENESS,
  };

  const wires = async (request: AdapterCompactRequest): Promise<[string, string][]> => {
    const fake = await startFake({ scenario: 'tools-ok', script: [] });
    const adapters = {
      chat: ccAdapterFor(fake),
      anthropic: createAnthropicAdapter({ ...shared, apiVersion: '2026-10-21', authSource: keyAuthSource(async () => 'unused') }),
      responses: createOpenResponsesAdapter({ ...shared, authSource: unauthenticatedSource }),
    };
    return Object.entries(adapters).map(([name, adapter]) => [name, JSON.stringify(adapter.renderCompactWire?.(request, target, 512, EVERY_REASONING_IS_OWN, REMOTE_CAPABILITIES))]);
  };

  it('carries the sections, the backtick rule and the guideline on each wire', async () => {
    const rendered = await wires(compactRequest({ guideline: GUIDELINE }));
    expect(rendered.map(([name]) => name)).toEqual(['chat', 'anthropic', 'responses']);
    for (const [, wire] of rendered) {
      for (const section of SECTIONS) expect(wire).toContain(section);
      expect(wire).toMatch(/in backticks/);
      expect(wire).toContain(GUIDELINE);
    }
  });
});

describe('momonga.guideline validation', () => {
  const parse = (guideline: unknown) =>
    createRequestValidator().parseCompact({ model: 'fast', input: [userText('hi')], momonga: { guideline } });

  it('accepts a guideline of exactly the cap', () => {
    const guideline = 'g'.repeat(MAX_COMPACTION_GUIDELINE_CHARS);
    expect(parse(guideline).momonga?.guideline).toBe(guideline);
  });

  it('refuses one character over the cap, naming the parameter', () => {
    expect(() => parse('g'.repeat(MAX_COMPACTION_GUIDELINE_CHARS + 1))).toThrow(/momonga\.guideline/);
  });

  it('counts estimated tokens, so a script that costs a token per character is held to the same reserve', () => {
    expect(parse('あ'.repeat(MIN_SUMMARY_TOKENS)).momonga?.guideline).toBe('あ'.repeat(MIN_SUMMARY_TOKENS));
    expect(() => parse('あ'.repeat(MIN_SUMMARY_TOKENS + 1))).toThrow(/momonga\.guideline/);
  });

  it('refuses a guideline that is not a string', () => {
    expect(() => parse(7)).toThrow(/momonga\.guideline/);
  });
});

describe('SUMMARY_PROMPT_TOKENS', () => {
  const transcriptEnvelope = (): string => {
    const [item] = summaryRequestOf({ ...compactRequest(), input: [] }, 512, EVERY_REASONING_IS_OWN).input;
    if (item?.type !== 'message' || typeof item.content !== 'string') throw new Error('an empty transcript is not a plain text message');
    return item.content;
  };

  it('is the longest fixed prompt, plus a guideline at the cap, plus the measured transcript envelope', () => {
    const longest = [KEEP_CLAUSE, RESTATE_CLAUSE]
      .map((clause) => instructionsOf(compactRequest(), 4096).replace(RESTATE_CLAUSE, clause))
      .reduce((a, b) => (a.length >= b.length ? a : b));
    const guidelineTokens = Math.ceil(MAX_COMPACTION_GUIDELINE_CHARS / ESTIMATED_CHARACTERS_PER_TOKEN);
    expect(SUMMARY_PROMPT_TOKENS).toBe(estimatedTokens(longest) + guidelineTokens + estimatedTokens(transcriptEnvelope()));
  });
});
