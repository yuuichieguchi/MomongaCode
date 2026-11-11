import { describe, expect, it } from 'vitest';
import { policyRefutedMessage, policyVerdictNotice, rulePropertyInWords } from '@momonga/protocol';
import type { PinnedRuleVerdict, RuleVerdict } from '@momonga/protocol';

const INTERNAL_WORDS = ['fingerprint', 'property identifier', 'solver', 'secret-reach', 'mandate-holds', 'superseded-forms'];

const refuted: RuleVerdict = {
  verdict: 'refuted',
  solver: 'Z3 4.15.0',
  refuted: [{ property: 'secret-reach', subject: 'Read', message: 'an allow rule opens a secret location', counterexample: 'Read /work/.env' }],
  unknown: [],
  notProved: ['shell commands.'],
};

const pinned = (verdict: RuleVerdict): PinnedRuleVerdict => ({ ...verdict, fingerprint: 'a'.repeat(64) });

describe('the texts of a rule verdict', () => {
  it('names each property in words', () => {
    expect(rulePropertyInWords('secret-reach')).toBe('no allow rule you wrote opens a secret location');
    expect(rulePropertyInWords('mandate-holds')).toBe('a run under a mandate stays inside it');
    expect(() => rulePropertyInWords('no-such-property')).toThrow('no-such-property');
  });

  it('refuses a run in one plain sentence that names the property, what breaks it and the way forward', () => {
    expect(policyRefutedMessage(refuted)).toBe(
      'The run was not started because a permission rule breaks a protection. The property that no allow rule you wrote opens a secret location is refuted for Read: an allow rule opens a secret location (for example Read /work/.env). Change that rule in the settings or the mandate, then run "momonga policy verify" to see the full report.',
    );
  });

  it('tells of a verification during the run without the internal words', () => {
    const text = policyVerdictNotice(pinned({ ...refuted, unknown: [{ property: 'mandate-holds', reason: 'the time for the proof ran out' }] }));
    expect(text).toBe(
      'The permission rules changed during the run and were verified again: a property is refuted. The property that no allow rule you wrote opens a secret location is refuted for Read: an allow rule opens a secret location (for example Read /work/.env). Not decided: the property that a run under a mandate stays inside it (the time for the proof ran out). Not proved: shell commands. Run "momonga policy verify" to see the full report.',
    );
    for (const word of INTERNAL_WORDS) expect(text).not.toContain(word);
    for (const word of INTERNAL_WORDS) expect(policyRefutedMessage(refuted)).not.toContain(word);
  });

  it('says plainly that no rule is refuted', () => {
    expect(policyVerdictNotice(pinned({ verdict: 'proved', solver: 'Z3', refuted: [], unknown: [], notProved: [] }))).toBe(
      'The permission rules changed during the run and were verified again: no rule is refuted.',
    );
  });
});
