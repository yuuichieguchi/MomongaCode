import { describe, expect, it } from 'vitest';
import { CALL_ROLES, COMPACTION_ROLE, HEADER_ROLES, RUN_ROLE } from '@momonga/protocol';

describe('the roles of a model call', () => {
  it('are run, compaction, classifier, reflection and analysis', () => {
    expect([...CALL_ROLES].sort()).toEqual(['analysis', 'classifier', 'compaction', 'reflection', 'run']);
  });

  it('derive the run role, the compaction role and the header roles from the one set', () => {
    expect(CALL_ROLES).toContain(RUN_ROLE);
    expect(CALL_ROLES).toContain(COMPACTION_ROLE);
    expect(RUN_ROLE).toBe('run');
    expect(COMPACTION_ROLE).toBe('compaction');
    expect([...HEADER_ROLES].sort()).toEqual(CALL_ROLES.filter((role) => role !== RUN_ROLE && role !== COMPACTION_ROLE).sort());
  });
});
