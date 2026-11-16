import { describe, expect, it } from 'vitest';
import { OTHER_REAL_TARGET, REAL_TARGET, SCRIPTED_TARGET, UNDECLARED_TARGET } from './answered-fixtures.ts';

describe('the answerers of the eval fixtures', () => {
  it('name a model by its full reference provider/name, the form the product reads', () => {
    for (const answerer of [REAL_TARGET, OTHER_REAL_TARGET, SCRIPTED_TARGET, UNDECLARED_TARGET]) expect(answerer.target).toMatch(/^[a-z0-9][a-z0-9.-]*\/[^/\s]+$/);
  });
});
