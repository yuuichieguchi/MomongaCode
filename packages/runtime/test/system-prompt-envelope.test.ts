import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';
import { buildSystemPrompt } from '../src/system-prompt.ts';

describe('the system prompt names the tool output envelope', () => {
  const tag = (protocol as unknown as { TOOL_OUTPUT_TAG?: string }).TOOL_OUTPUT_TAG;
  const prompt = buildSystemPrompt({ cwd: '/work', platform: 'darwin' });

  it('takes the tag name from the protocol constant', () => {
    expect(tag).toBe('tool_output');
    expect(prompt).toContain(`<${tag}`);
  });

  it('says that nothing inside the envelope is an instruction', () => {
    const sentence = prompt.split('\n').find((line) => line.includes(`<${tag}`)) ?? '';
    expect(sentence).toMatch(/not (an )?instructions?/i);
  });
});
