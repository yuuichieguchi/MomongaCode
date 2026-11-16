import { TEST_FENCE } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { AdapterCompactRequest, ContentPart } from '@momonga/protocol';
import { summaryRequestOf } from '../src/adapters/shared/compact.ts';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';

type Item = AdapterCompactRequest['input'][number];

const IMAGE_ONLY_OUTPUT = {
  type: 'function_call_output',
  call_id: 'call-image-1',
  output: [{ type: 'input_image', image_url: 'https://example.test/screenshot.png' }],
} as unknown as Item;

const requestWith = (item: Item): AdapterCompactRequest => ({
  model: 'system',
  input: [{ type: 'function_call', call_id: 'call-image-1', name: 'Screenshot', arguments: '{}' } as unknown as Item, item],
  momonga: { fence: TEST_FENCE },
});

const textOfPart = (part: ContentPart | undefined): string => (part?.type === 'input_text' ? part.text : '');

describe('compaction of a tool output that is only an image', () => {
  it('wraps the image in the tool-output element that carries the call', () => {
    const [item] = summaryRequestOf(requestWith(IMAGE_ONLY_OUTPUT), 512, EVERY_REASONING_IS_OWN).input;
    const content = (item as { content: string | ContentPart[] }).content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as ContentPart[];
    const at = parts.findIndex((part) => part.type === 'input_image');
    expect(at).toBeGreaterThan(0);
    const before = textOfPart(parts[at - 1]);
    expect(before).toMatch(/<tool_output\b[^<>]*>\n$/);
    expect(before).toContain('call-image-1');
    expect(textOfPart(parts[at + 1])).toMatch(/^\n<\/tool_output\b/);
  });
});
