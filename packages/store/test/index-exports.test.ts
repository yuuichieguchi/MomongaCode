import { describe, expect, it } from 'vitest';
import * as store from '../src/index.ts';

describe('the store exports', () => {
  it('exports no second inheritance projection', () => {
    expect(Object.keys(store)).not.toContain('projectInheritance');
  });
});
