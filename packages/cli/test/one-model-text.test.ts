import { sessionModelNotConfiguredText } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { notConfiguredAnyMoreText } from '../src/tui/models/texts.ts';

describe('the sentence of a model that is not configured any more', () => {
  it('has one definition that the screen and the run refusal both use', () => {
    expect(notConfiguredAnyMoreText).toBe(sessionModelNotConfiguredText);
  });
});
