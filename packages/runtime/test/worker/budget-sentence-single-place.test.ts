import { describe, expect, it } from 'vitest';
import * as budget from '../../src/worker/budget.ts';
import * as admitted from '../../src/worker/admitted-request.ts';

describe('the budget sentence has one writer', () => {
  it('the runtime budget module does not write the sentence; the protocol vocabulary does', () => {
    expect('exhaustedText' in budget).toBe(false);
    expect('exhaustedMessage' in admitted).toBe(true);
  });
});
