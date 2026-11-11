import { describe, expect, it } from 'vitest';
import { CLASSIFIER_INSTRUCTIONS } from '../../src/worker/auto-classifier.ts';

describe('the instructions of the auto-mode classifier', () => {
  it('say that a requested network scope is part of the call it judges', () => {
    expect(CLASSIFIER_INSTRUCTIONS).toContain(
      'A network scope that the call requests is part of the call: judge whether the user request needs that access, and answer "unsafe" for unrestricted access or for a host the user request does not call for.',
    );
  });
});
