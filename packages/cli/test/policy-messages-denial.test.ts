import { describe, expect, it } from 'vitest';
import { PERMISSION_DENIAL_SOURCES } from '@momonga/protocol';
import { describeDenial } from '../src/policy-messages.ts';

describe('the text of a refusal names its source', () => {
  it('has words for every source a refusal can carry', () => {
    expect([...PERMISSION_DENIAL_SOURCES].sort()).toEqual(['held', 'hook', 'mandate', 'mode', 'rule', 'sandbox', 'setting', 'superseded']);
    for (const source of PERMISSION_DENIAL_SOURCES) expect(describeDenial({ source, reason: 'why' })).toMatch(/^denied by \S.*: why$/);
  });

  it('says a setting refused a call the setting refused, and names the mandate for a replaced command', () => {
    expect(describeDenial({ source: 'setting', reason: 'the command requests unrestricted network access, and the setting sandboxNetwork is deny' })).toBe(
      'denied by a setting: the command requests unrestricted network access, and the setting sandboxNetwork is deny',
    );
    expect(describeDenial({ source: 'superseded', reason: 'Not run: this run has a mandate, and git push is replaced by a dedicated operation; use GitPush' })).toBe(
      'denied by the mandate of this run, which replaces the command: Not run: this run has a mandate, and git push is replaced by a dedicated operation; use GitPush',
    );
  });
});
