import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { validateToolInput } from '@momonga/tools';
import { makeTool } from './harness.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const treeArguments = (depth: number): string => `{"tree":${nestedArraysText(depth - 1)}}`;

const tree = makeTool('Tree', { inputSchema: { type: 'object', properties: { tree: { type: 'array' } }, required: ['tree'] } });

describe('validateToolInput and the one JSON depth bound', () => {
  it(`accepts arguments nested exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const verdict = await validateToolInput(tree, treeArguments(MAX_JSON_DEPTH));
    expect(verdict.ok).toBe(true);
  });

  it.each([
    ['text', (depth: number): unknown => treeArguments(depth)],
    ['an already parsed value', (depth: number): unknown => JSON.parse(treeArguments(depth)) as unknown],
  ])(`refuses %s nested ${MAX_JSON_DEPTH + 1} deep as invalid input naming the depth`, async (_label, argumentsOf) => {
    const verdict = await validateToolInput(tree, argumentsOf(MAX_JSON_DEPTH + 1));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('invalid');
    expect(verdict.message).toContain('Tree');
    expect(verdict.message).toMatch(/depth/i);
    expect(verdict.message).toContain(String(MAX_JSON_DEPTH));
  });
});
