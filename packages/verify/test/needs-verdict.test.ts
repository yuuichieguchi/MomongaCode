import { describe, expect, it } from 'vitest';
import { needsVerdict } from '../src/index.ts';
import { makeLayout, rulesOf } from './harness.ts';

describe('whether a rule set needs a verdict before a run', () => {
  it('needs none when it holds no allow rule: nothing in it can open what the protection forbids', () => {
    const layout = makeLayout();
    expect(needsVerdict({ rules: [] })).toBe(false);
    expect(needsVerdict({ rules: rulesOf(layout, [['deny', 'Read(.env)'], ['deny', 'Bash(git push:*)'], ['ask', 'Write']]) })).toBe(false);
  });

  it('needs one as soon as one allow rule is written', () => {
    const layout = makeLayout();
    expect(needsVerdict({ rules: rulesOf(layout, [['deny', 'Read(.env)'], ['allow', 'Read(src/**)']]) })).toBe(true);
  });

  it('needs one when the properties of a mandate are asked for, whatever the rules', () => {
    expect(needsVerdict({ rules: [], supersededForms: [] })).toBe(true);
    expect(needsVerdict({ rules: [], alwaysOperations: [] })).toBe(true);
  });
});
