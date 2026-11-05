import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { parseHookOutput } from '../src/hooks/output.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const stdoutOf = (depth: number): string => `{"systemMessage":"ok","extra":${nestedArraysText(depth - 1)}}`;

describe('hook stdout and the one JSON depth bound', () => {
  it(`reads hook output nested exactly ${MAX_JSON_DEPTH} deep`, () => {
    expect(parseHookOutput('PostToolUse', stdoutOf(MAX_JSON_DEPTH))).toEqual({ ok: true, value: { systemMessage: 'ok' } });
  });

  it(`refuses hook output nested ${MAX_JSON_DEPTH + 1} deep with the invalid-output result naming the depth`, () => {
    const result = parseHookOutput('PostToolUse', stdoutOf(MAX_JSON_DEPTH + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/depth/i);
    expect(result.message).toContain(String(MAX_JSON_DEPTH));
  });
});
