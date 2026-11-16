import { describe, expect, it } from 'vitest';
import { FM_SERVER } from '@momonga/protocol';
import { builtInRowOf } from '../../src/tui/models/add.ts';

describe('the row of a managed server takes its label from the server description', () => {
  it('names the Apple server by the label of its description, and a second server by its own', () => {
    expect(builtInRowOf(FM_SERVER)).toBe('Use the Apple on-device model');
    expect(builtInRowOf({ label: 'the other local model' })).toBe('Use the other local model');
  });
});
