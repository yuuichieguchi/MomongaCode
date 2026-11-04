import { describe, expect, it } from 'vitest';
import type { FunctionTool, InputItem } from '@momonga/protocol';
import { prefixRelationOf } from '../../src/worker/prefix-relation.ts';

const ECHO: FunctionTool = { type: 'function', name: 'Echo', description: 'Echo a value', parameters: { type: 'object', properties: {} } };
const WRITE: FunctionTool = { type: 'function', name: 'Write', description: 'Write a file', parameters: { type: 'object', properties: {} } };

const message = (role: 'system' | 'developer' | 'user' | 'assistant', content: string): InputItem => ({ type: 'message', role, content });

const system = message('system', 'You are the agent.');
const task = message('user', 'Do the work.');
const answer = message('assistant', 'Working.');
const workingState = message('developer', 'Working state v1.');

describe('prefixRelationOf compares two consecutive requests by their leading items (section 1, 9)', () => {
  it('preserves every item of the previous request when the next one extends it', () => {
    expect(prefixRelationOf({ input: [system, task], tools: [ECHO] }, { input: [system, task, answer], tools: [ECHO] })).toEqual({
      preservedItems: 2,
      toolsChanged: false,
    });
  });

  it('preserves the items before the first one that differs', () => {
    const replaced = message('developer', 'Working state v2.');
    expect(prefixRelationOf({ input: [system, task, answer, workingState], tools: [ECHO] }, { input: [system, task, answer, replaced], tools: [ECHO] })).toEqual({
      preservedItems: 3,
      toolsChanged: false,
    });
  });

  it('preserves nothing when the first item differs', () => {
    expect(prefixRelationOf({ input: [system, task], tools: [ECHO] }, { input: [message('system', 'Other.'), task], tools: [ECHO] })).toEqual({
      preservedItems: 0,
      toolsChanged: false,
    });
  });

  it('preserves nothing and reports the tools as changed when the tools differ', () => {
    expect(prefixRelationOf({ input: [system, task], tools: [ECHO] }, { input: [system, task, answer], tools: [ECHO, WRITE] })).toEqual({
      preservedItems: 0,
      toolsChanged: true,
    });
  });

  it('treats a reordered tools array as changed', () => {
    expect(prefixRelationOf({ input: [system], tools: [ECHO, WRITE] }, { input: [system], tools: [WRITE, ECHO] }).toolsChanged).toBe(true);
  });
});
