import { describe, expectTypeOf, it } from 'vitest';
import type { ToolChoice } from '../src/open-responses.ts';

describe('the protocol ToolChoice type', () => {
  it('includes the allowed-set member', () => {
    expectTypeOf<{ type: 'allowed_tools'; tools: Array<{ type: 'function'; name: string }>; mode: 'auto' | 'required' | 'none' }>().toExtend<ToolChoice>();
  });
});
